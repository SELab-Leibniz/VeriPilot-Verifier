"""Actual selected-image/Conda/base-only-workspace/Gateway qualification.

No agent task, model ticket, grader or hidden dataset column is used. Root alone
runs this after preparing the official local image and temporary setup bridge.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--image-ref", required=True)
    parser.add_argument("--expected-image-id", required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--controller-descriptor", type=Path, required=True)
    parser.add_argument("--cpus", type=int, required=True)
    parser.add_argument("--memory-mb", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--install-cache", type=Path)
    parser.add_argument("--cache-compose", type=Path)
    args = parser.parse_args()
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", args.expected_image_id)
    assert args.cpus > 0 and args.memory_mb > 0
    samples = json.loads(args.samples.read_text())
    rows = [row for row in samples["selected"] if row["instance_id"] == args.instance_id]
    assert len(rows) == 1 and samples["sampleCount"] == 3
    row = rows[0]
    # Read-only local inspection; this probe never pulls/rebuilds/re-tags images.
    inspected = subprocess.check_output(["docker", "image", "inspect", args.image_ref,
        "--format", "{{.Id}}"], text=True).strip()
    assert inspected == args.expected_image_id
    args.output.mkdir()
    from harbor.environments.docker.docker import DockerEnvironment
    from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
    from harbor.models.trial.paths import TrialPaths
    from scripts.bench.swebench_lite_gateway import SweBenchLiteGatewayOpenClaw, HELPER

    context = args.output / "public-environment"
    context.mkdir()
    (context / "Dockerfile").write_text("# Public prebuilt-image port only; no image build by this probe.\nFROM " + args.image_ref + "\n")
    paths = TrialPaths(trial_dir=args.output / "trial")
    paths.mkdir()
    cache = json.loads(args.install_cache.read_text()) if args.install_cache else {"mounts": []}
    for mount in cache["mounts"]:
        assert mount["type"] == "volume" and mount["target"] in {"/root/.nvm", "/root/.npm"}
    helper = SOURCE / "scripts/bench/swebench-lite-workspace.mjs"
    artifact = args.artifact.resolve(strict=True)
    hashes = {str(p.relative_to(artifact)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(artifact.rglob("*")) if p.is_file()}
    environment = DockerEnvironment(environment_dir=context, environment_name="rc-lite-native-qualification",
        session_id="rc-lite-probe-" + uuid.uuid4().hex[:12], trial_paths=paths,
        task_env_config=EnvironmentConfig(docker_image=args.image_ref, workdir="/testbed",
            cpus=args.cpus, memory_mb=args.memory_mb),
        network_policy=NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=["host.docker.internal"]),
        extra_docker_compose=[args.cache_compose] if args.cache_compose else [], mounts=[
            {"type": "bind", "source": str(paths.agent_dir.resolve()), "target": "/logs/agent"},
            {"type": "bind", "source": str(artifact), "target": "/opt/rc-artifact", "read_only": True},
            {"type": "bind", "source": str(helper.resolve()), "target": HELPER, "read_only": True}, *cache["mounts"]])
    result = {"state": "INCOMPLETE", "instanceId": args.instance_id, "baseCommit": row["base_commit"],
        "declaredOfficialImage": row["image"], "localImageRef": args.image_ref,
        "localImageId": inspected, "resources": {"cpus": args.cpus, "memoryMb": args.memory_mb},
        "qualificationResourcesAreNotOfficialAgentBudget": True,
        "realModelRequests": 0, "originalTaskSubmitted": False, "graderExecuted": False,
        "privateDatasetRead": False, "arms": []}

    async def presence():
        check = await environment.exec(command='for n in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY; do '
            'if printenv "$n" >/dev/null; then printf "%s=present\\n" "$n"; else printf "%s=absent\\n" "$n"; fi; done', timeout_sec=10)
        assert check.return_code == 0
        values = dict(line.split("=", 1) for line in (check.stdout or "").splitlines())
        assert len(values) == 6 and set(values.values()) <= {"present", "absent"}
        return {key: value == "present" for key, value in values.items()}

    try:
        await environment.start(force_build=False)
        result["proxyBeforeSetup"] = await presence()
        agent = SweBenchLiteGatewayOpenClaw(logs_dir=paths.agent_dir, model_name="openai/glm-5.3",
            rc_artifact_path=artifact, rc_artifact_remote_path="/opt/rc-artifact",
            rc_controller_descriptor=args.controller_descriptor,
            rc_metering_receipt=args.output / "unused-no-model-receipt.json", rc_official_wall_ms=120000,
            rc_instance_id=args.instance_id, rc_base_commit=row["base_commit"],
            rc_problem_statement_sha256=row["problemStatementSha256"])
        began = time.monotonic()
        await asyncio.wait_for(agent.setup(environment), timeout=1200)
        result["setupSeconds"] = time.monotonic() - began
        result["proxyAfterSetup"] = await presence()
        assert result["proxyBeforeSetup"] == result["proxyAfterSetup"] and not any(result["proxyAfterSetup"].values())
        result["workspaceBoundary"] = json.loads((paths.agent_dir / "lite-prepare-result.json").read_text())
        result["businessEnvironment"] = json.loads((paths.agent_dir / "lite-business-environment.json").read_text())
        result["setupNetwork"] = json.loads((paths.agent_dir / "lite-setup-network.json").read_text())
        with environment.scoped_exec_env(agent.business_exec_environment()):
            readonly_code = ('import os,errno,json; paths=' + repr([HELPER, "/opt/rc-artifact/package.json"])
                + ';\nfor p in paths:\n try:\n  fd=os.open(p,os.O_WRONLY);os.close(fd);raise RuntimeError("mount is writable")'
                + '\n except OSError as e:\n  assert e.errno==errno.EROFS\nprint(json.dumps({"writeOpenDenied":True,"files":len(paths)}))')
            readonly = await agent.exec_as_agent(environment, "python -c " + shlex.quote(readonly_code), timeout_sec=10)
            assert json.loads(readonly.stdout or "")["writeOpenDenied"]
            result["artifactAndHelperReadonlyWriteOpenDenied"] = True
            # The actual Node process used for Gateway startup must resolve
            # the same testbed Python after nvm adds Node22 to PATH.
            js = 'const {execFileSync}=require("node:child_process");process.stdout.write(execFileSync("python",["-c","import sys;print(sys.executable);print(sys.prefix)"],{encoding:"utf8"}));'
            python = await agent.exec_as_agent(environment, '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && node -e ' + shlex.quote(js), timeout_sec=20)
            lines = (python.stdout or "").splitlines()
            assert lines == [result["businessEnvironment"]["executable"], result["businessEnvironment"]["prefix"]]
            result["actualNodeChildPythonMatchesTestbed"] = True
            module = {"pytest-dev/pytest": "pytest", "sympy/sympy": "sympy", "django/django": "django"}[row["repo"]]
            # Docker exec may merge stderr warnings into stdout. Keep the
            # qualified import result in a fresh structured artifact rather
            # than interpreting ordinary project diagnostics as JSON.
            import_result = "/logs/agent/lite-project-import.json"
            module_code = ("import importlib,json,os; m=importlib.import_module(" + repr(module)
                + "); open(" + repr(import_result) + ", 'x').write(json.dumps({\"module\":"
                + repr(module) + ",\"file\":os.path.realpath(m.__file__)}))")
            await agent.exec_as_agent(environment, "python -c " + shlex.quote(module_code), timeout_sec=20)
            local_import = paths.agent_dir / "lite-project-import.json"
            await environment.download_file(import_result, local_import)
            result["actualProjectImport"] = json.loads(local_import.read_text())
            assert result["actualProjectImport"]["file"].startswith("/testbed/"), "Interpreter imports a package outside the public task base"
            npm = await agent.exec_as_agent(environment, '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && npm root -g')
            host_root = (npm.stdout or "").strip() + "/openclaw"
            remote = "/logs/agent/rc-lite-bootstrap"
            await agent.exec_as_agent(environment, "mkdir -p " + remote)
            for name in ["harbor-container-bootstrap.mjs", "harbor-gateway-runner.mjs", "harbor-gateway-controller.mjs", "prepare-harbor-workspace.mjs"]:
                await environment.upload_file(SOURCE / "scripts/bench" / name, remote + "/" + name)
            for name in ["harbor-evaluation.yaml", "harbor-document-review.md"]:
                await environment.upload_file(SOURCE / "config" / name, remote + "/" + name)
            for enabled in [False, True]:
                arm = "on" if enabled else "off"
                ticket = {"kind": "rc-harbor-relay-ticket-v1", "model": "openai/glm-5.3",
                    "relayBaseUrl": "http://127.0.0.1:1/v1", "placeholderCredential": "rc-placeholder-" + "c" * 64,
                    "deadlineAt": int(time.time() * 1000) + 120000, "officialWallMs": 120000,
                    "tokenLimits": {"inputPerRequest": 262144, "outputPerRequest": 32768,
                        "totalInput": 524288, "totalOutput": 65536, "requests": 2}}
                spec = {"hostRoot": host_root, "projectRoot": "/testbed", "pluginRoot": "/opt/rc-artifact",
                    "outputRoot": remote + "/" + arm, "ticket": ticket, "rcEnabled": enabled,
                    "artifactHashes": hashes, "policyPath": remote + "/harbor-evaluation.yaml",
                    "criteriaPath": remote + "/harbor-document-review.md", "resultPath": remote + "/" + arm + ".json"}
                local = args.output / ("bootstrap-" + arm + ".json")
                local.write_text(json.dumps(spec))
                await environment.upload_file(local, remote + "/spec-" + arm + ".json")
                await agent.exec_as_agent(environment, '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && node '
                    + remote + "/harbor-container-bootstrap.mjs " + remote + "/spec-" + arm + ".json", timeout_sec=90)
                await environment.download_file(spec["resultPath"], local)
                observed = json.loads(local.read_text())
                assert observed["rcEnabled"] == enabled and observed["pluginLoaded"] == enabled and not observed["modelStarts"]
                result["arms"].append(observed)
        same = await environment.exec(command="git -C /testbed diff --quiet " + row["base_commit"] + " --", timeout_sec=15)
        assert same.return_code == 0
        result["businessTrackedSourceUnchanged"] = True
        result["state"] = "ACTUAL_LITE_IMAGE_TESTBED_PYTHON_BASE_ONLY_GIT_AND_BOTH_GATEWAYS_NO_MODELS"
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        try:
            await environment.stop(delete=True)
            result["ownContainersRemoved"] = True
        except Exception as error:
            result["cleanupError"] = {"type": type(error).__name__}
        (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"state": result["state"], "instanceId": args.instance_id, "realModelRequests": 0}))
    if result["state"] == "INCOMPLETE":
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
