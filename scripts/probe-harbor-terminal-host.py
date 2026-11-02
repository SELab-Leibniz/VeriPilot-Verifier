"""Actual official TB environment + inherited host install, with no task/model.

Only public task.toml and three business-file hashes are read. No tests or
solutions are read/uploaded/run. Own containers are removed at completion.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import shlex
import subprocess
import sys
import time
import tomllib
import uuid
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))


async def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--install-cache", type=Path)
    parser.add_argument("--cache-compose", type=Path)
    parser.add_argument("--controller-descriptor", type=Path,
        help="Host-only controller descriptor with optional setupProxyUrl; never uploaded or logged")
    args = parser.parse_args(); args.output.mkdir()
    from harbor.environments.docker.docker import DockerEnvironment
    from harbor.models.task.config import TaskConfig
    from harbor.models.trial.paths import TrialPaths
    from scripts.bench.harbor_rc_gateway import RcGatewayOpenClaw
    raw_config = (args.task / "task.toml").read_bytes(); task = TaskConfig.model_validate(tomllib.loads(raw_config.decode()))
    assert task.environment.docker_image == "alexgshaw/overfull-hbox:20260403"
    assert task.environment.cpus == 2 and task.environment.memory_mb == 4096 and task.agent.timeout_sec == 750
    paths = TrialPaths(trial_dir=args.output / "trial"); paths.mkdir()
    artifact = args.artifact.resolve(strict=True)
    artifact_hashes = {str(file.relative_to(artifact)): hashlib.sha256(file.read_bytes()).hexdigest()
                       for file in sorted(artifact.rglob("*")) if file.is_file()}
    cache = json.loads(args.install_cache.read_text()) if args.install_cache else {"mounts": []}
    for mount in cache["mounts"]:
        assert mount["type"] == "volume" and mount["target"] in {"/root/.nvm", "/root/.npm"}
        subprocess.run(["docker", "volume", "inspect", mount["source"]], check=True, stdout=subprocess.DEVNULL)
    environment = DockerEnvironment(environment_dir=args.task / "environment", environment_name="rc-tb-host-preflight",
        session_id="rc-tb-probe-" + uuid.uuid4().hex[:12], trial_paths=paths, task_env_config=task.environment,
        network_policy=task.environment.resolve_baseline(), extra_docker_compose=[args.cache_compose] if args.cache_compose else [], mounts=[
            {"type": "bind", "source": str(paths.agent_dir.resolve()), "target": "/logs/agent"},
            {"type": "bind", "source": str(artifact), "target": "/opt/rc-artifact", "read_only": True}, *cache["mounts"]])
    result = {"state": "INCOMPLETE", "realModelRequests": 0, "originalTaskSubmitted": False,
        "taskConfigSha256": hashlib.sha256(raw_config).hexdigest(), "declaredImage": task.environment.docker_image,
        "officialAgentTimeoutSec": task.agent.timeout_sec, "resources": {"cpus": 2, "memoryMb": 4096}, "arms": []}
    result["installCache"] = cache
    result["cacheCompose"] = str(args.cache_compose) if args.cache_compose else None
    try:
        await environment.start(force_build=False)
        hashes = await environment.exec(command="sha256sum /app/input.tex /app/main.tex /app/synonyms.txt", timeout_sec=10)
        assert hashes.return_code == 0; result["beforeBusinessHashes"] = hashes.stdout
        before_native = await environment.exec(command="test ! -e /root/.nvm || echo existing-nvm", timeout_sec=10)
        result["isolatedContainerSetup"] = (before_native.stdout or "").strip()
        agent_kwargs = ({"rc_controller_descriptor": args.controller_descriptor}
            if args.controller_descriptor else {"rc_relay_ticket": args.output / "unused-public-ticket.json"})
        agent = RcGatewayOpenClaw(logs_dir=paths.agent_dir, model_name="openai/glm-5.3",
            rc_artifact_path=artifact, rc_metering_receipt=args.output / "unused-receipt.json", **agent_kwargs)
        proxy_names = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY")
        # Read presence only: proxy credentials and environment values must not
        # enter agent logs or the qualification result.
        proxy_presence_command = "for name in " + " ".join(proxy_names) + "; do " + (
            'if printenv "$name" >/dev/null; then printf "%s=present\\n" "$name"; '
            'else printf "%s=absent\\n" "$name"; fi; done')
        async def proxy_presence():
            observation = await environment.exec(command=proxy_presence_command, timeout_sec=10)
            assert observation.return_code == 0
            pairs = dict(line.split("=", 1) for line in (observation.stdout or "").splitlines())
            assert set(pairs) == set(proxy_names) and set(pairs.values()) <= {"present", "absent"}
            return {name: pairs[name] == "present" for name in proxy_names}
        result["setupProxyEnvironment"] = {"descriptorSupplied": args.controller_descriptor is not None,
            "beforeSetup": await proxy_presence(), "valuesOrCapabilitiesRecorded": False}
        began = time.time(); setup_error = None
        try:
            await asyncio.wait_for(agent.setup(environment), timeout=1200)
        except BaseException as error:
            setup_error = error
            raise
        finally:
            try:
                result["setupProxyEnvironment"]["afterSetup"] = await proxy_presence()
                result["setupProxyEnvironment"]["unchanged"] = (
                    result["setupProxyEnvironment"]["beforeSetup"] == result["setupProxyEnvironment"]["afterSetup"])
                result["setupProxyEnvironment"]["allAbsentAfterSetup"] = not any(
                    result["setupProxyEnvironment"]["afterSetup"].values())
            except Exception as error:
                result["setupProxyEnvironment"]["afterProbeError"] = {"type": type(error).__name__}
                # A failed observation must not replace the original install
                # failure or be misreported as an empty environment.
                if setup_error is None:
                    raise
        result["hostInstallElapsedSec"] = time.time() - began
        assert result["setupProxyEnvironment"]["unchanged"], "Setup proxy environment was not restored"
        if args.controller_descriptor:
            assert result["setupProxyEnvironment"]["allAbsentAfterSetup"], "Proxy variables remain after setup"
        host = await agent.exec_as_agent(environment, '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && npm root -g')
        host_root = host.stdout.strip() + "/openclaw"
        version = await agent.exec_as_agent(environment, '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && node --version && openclaw --version')
        result["installedVersions"] = version.stdout
        assert "2026.7.1-2" in version.stdout
        readonly = await environment.exec(command="touch /opt/rc-artifact/rc-readonly-probe 2>/dev/null", timeout_sec=10)
        assert readonly.return_code != 0; result["artifactReadOnlyWriteRejected"] = True
        remote = "/logs/agent/rc-runtime"
        await agent.exec_as_agent(environment, "mkdir -p " + remote)
        for name in ("harbor-container-bootstrap.mjs", "harbor-gateway-runner.mjs", "harbor-gateway-controller.mjs", "prepare-harbor-workspace.mjs"):
            await environment.upload_file(SOURCE / "scripts/bench" / name, remote + "/" + name)
        for name in ("harbor-evaluation.yaml", "harbor-document-review.md"):
            await environment.upload_file(SOURCE / "config" / name, remote + "/" + name)
        for enabled in (False, True):
            arm = "on" if enabled else "off"
            ticket = {"kind": "rc-harbor-relay-ticket-v1", "model": "openai/glm-5.3", "relayBaseUrl": "http://127.0.0.1:1/v1",
                "placeholderCredential": "rc-placeholder-" + "c" * 64, "deadlineAt": int(time.time() * 1000) + 120000,
                "officialWallMs": 120000, "tokenLimits": {"inputPerRequest": 262144, "outputPerRequest": 32768,
                "totalInput": 524288, "totalOutput": 65536, "requests": 2}}
            spec = {"hostRoot": host_root, "projectRoot": "/app", "pluginRoot": "/opt/rc-artifact", "outputRoot": remote + "/bootstrap-" + arm,
                "ticket": ticket, "rcEnabled": enabled, "artifactHashes": artifact_hashes,
                "policyPath": remote + "/harbor-evaluation.yaml", "criteriaPath": remote + "/harbor-document-review.md",
                "resultPath": remote + "/bootstrap-" + arm + ".json"}
            local = args.output / ("bootstrap-" + arm + ".json"); local.write_text(json.dumps(spec))
            await environment.upload_file(local, remote + "/spec-" + arm + ".json")
            command = '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && node ' + remote + "/harbor-container-bootstrap.mjs " + remote + "/spec-" + arm + ".json"
            await agent.exec_as_agent(environment, command, env={"OPENAI_API_KEY": ticket["placeholderCredential"]}, timeout_sec=60)
            await environment.download_file(spec["resultPath"], local)
            observed = json.loads(local.read_text()); assert observed["rcEnabled"] == enabled and not observed["modelStarts"]
            assert observed["pluginLoaded"] == enabled and observed["operationalPolicy"]["projectEnabled"]
            result["arms"].append(observed)
        after = await environment.exec(command="sha256sum /app/input.tex /app/main.tex /app/synonyms.txt", timeout_sec=10)
        assert after.stdout == hashes.stdout; result["afterBusinessHashes"] = after.stdout
        result["state"] = "OFFICIAL_TB_CONTAINER_PINNED_HOST_BOTH_ARMS_ACTIVE_POLICY_NO_MODELS"
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        try:
            await environment.stop(delete=True); result["ownContainersRemoved"] = True
        except Exception as error:
            result["cleanupError"] = {"type": type(error).__name__, "message": str(error)}
        (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"state": result["state"], "realModelRequests": 0}))
    if result["state"] == "INCOMPLETE": raise SystemExit(1)


if __name__ == "__main__": asyncio.run(main())
