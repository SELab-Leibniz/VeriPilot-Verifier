"""Exercise setup-only proxy scope through the pinned Docker environment ports.

The actual OpenClaw.setup and DockerEnvironment.exec/scoped_exec_env methods
run. Installation and the final Compose process boundary are intercepted: no
container, package installation, network request or model is started.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import socket
import sys
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir()

    def deny_network(*_args, **_kwargs):
        raise AssertionError("Setup scope probe may not use the network")

    socket.socket.connect = deny_network
    from harbor.agents.installed.openclaw import OpenClaw
    from harbor.environments.base import ExecResult
    from harbor.environments.docker.docker import DockerEnvironment
    from harbor.models.task.config import EnvironmentConfig
    from harbor.models.trial.paths import TrialPaths
    from scripts.bench.harbor_rc_gateway import RcGatewayOpenClaw, setup_proxy_env

    definition = args.output / "neutral-environment"
    definition.mkdir()
    (definition / "Dockerfile").write_text("FROM scratch\n")
    paths = TrialPaths(trial_dir=args.output / "trial")
    paths.mkdir()
    original = {"RC_SCOPE_MARKER": "unchanged", "HTTP_PROXY": "http://original.invalid:8080"}
    environment = DockerEnvironment(environment_dir=definition,
        environment_name="rc-setup-scope-no-container", session_id="rc-setup-scope-no-container",
        trial_paths=paths, task_env_config=EnvironmentConfig(), persistent_env=dict(original))
    proxy = "http://rc-setup:" + "a" * 64 + "@host.docker.internal:34567"
    expected = {**original, **setup_proxy_env(proxy)}
    calls: list[dict[str, str]] = []

    async def compose_boundary(command, **_kwargs):
        assert command[0] == "exec", "Only actual exec-port formatting may reach this interception"
        forwarded = {}
        for index, arg in enumerate(command):
            if arg == "-e":
                key, value = command[index + 1].split("=", 1)
                forwarded[key] = value
        calls.append(forwarded)
        return ExecResult(return_code=0, stdout="", stderr="")

    async def observed_env() -> dict[str, str]:
        await environment.exec(command="true")
        return calls[-1]

    summaries = []
    original_install = OpenClaw.install
    for label, enabled, descriptor_proxy, outcome in (
        ("off", False, True, "success"),
        ("on", True, True, "success"),
        ("install-error", True, True, "error"),
        ("install-cancel", True, True, "cancel"),
        ("no-field", True, False, "success"),
        ("static-ticket", False, False, "success"),
    ):
        descriptor = args.output / (label + "-controller.json")
        data = {"kind": "rc-harbor-controller-v1", "startUrl": "http://127.0.0.1:34568/start",
                "controlToken": "rc-control-" + "b" * 64}
        if descriptor_proxy:
            data["setupProxyUrl"] = proxy
        descriptor.write_text(json.dumps(data))
        kwargs = ({"rc_relay_ticket": args.output / "unused-offline-ticket"} if label == "static-ticket"
                  else {"rc_controller_descriptor": descriptor})
        agent = RcGatewayOpenClaw(logs_dir=args.output / label, model_name="openai/glm-5.3",
            rc_artifact_path=args.output, rc_metering_receipt=args.output / "unused-receipt",
            rc_enabled=enabled, **kwargs)
        installed = 0
        during = None
        outside_ready = asyncio.Event()
        outside_done = asyncio.Event()

        async def concurrent_observer():
            await outside_ready.wait()
            assert await observed_env() == original
            outside_done.set()

        async def install_boundary(self, actual_environment):
            nonlocal installed, during
            assert actual_environment is environment
            installed += 1
            during = await observed_env()
            assert during == (expected if descriptor_proxy else original)
            outside_ready.set()
            await outside_done.wait()
            assert await observed_env() == during
            if outcome == "error":
                raise RuntimeError("controlled installation failure")
            if outcome == "cancel":
                raise asyncio.CancelledError()

        with patch.object(environment, "_run_docker_compose_command", compose_boundary):
            assert await observed_env() == original
            observer = asyncio.create_task(concurrent_observer())
            try:
                with patch.object(OpenClaw, "install", install_boundary):
                    try:
                        await agent.setup(environment)
                    except RuntimeError as error:
                        assert outcome == "error" and str(error) == "controlled installation failure"
                    except asyncio.CancelledError:
                        assert outcome == "cancel"
                    else:
                        assert outcome == "success"
                await observer
                assert installed == 1
                assert await observed_env() == original
                assert environment._persistent_env == original
                assert not environment._exec_env_overlays.get()
            finally:
                if not observer.done():
                    observer.cancel()
                    await asyncio.gather(observer, return_exceptions=True)
        # This is only a synthetic capability; avoid retaining even that value.
        descriptor.unlink()
        summaries.append({"case": label, "originalSetupCalled": True,
            "realEnvironmentExecPortUsed": True, "temporaryProxyPresentDuringSetup": descriptor_proxy,
            "scopeRestoredAfterSetup": True, "concurrentTaskUnaffected": True,
            "persistentEnvironmentUnchanged": True, "installationOutcome": outcome})

    assert OpenClaw.install is original_install
    malformed = [None, 1, "", proxy + "/", proxy + "?x=1", proxy + "#x",
        proxy.replace("http://", "https://"), proxy.replace("rc-setup:", "other:"),
        proxy.replace("host.docker.internal", "localhost"), proxy.replace("host.docker.internal", "host.docker.internal.evil"),
        proxy.replace("a" * 64, "a" * 63), proxy.replace("a" * 64, "g" * 64),
        proxy.replace(":34567", ":0"), proxy.replace(":34567", ":65536"), proxy + "\n"]
    rejected = 0
    for value in malformed:
        descriptor = args.output / "invalid-controller.json"
        descriptor.write_text(json.dumps({"kind": "rc-harbor-controller-v1", "setupProxyUrl": value}))
        agent = RcGatewayOpenClaw(logs_dir=args.output / "invalid", model_name="openai/glm-5.3",
            rc_artifact_path=args.output, rc_controller_descriptor=descriptor,
            rc_metering_receipt=args.output / "unused-receipt")
        async def forbidden_install(*_args, **_kwargs):
            raise AssertionError("Invalid proxy must fail before the original installer")
        with patch.object(OpenClaw, "setup", forbidden_install):
            try:
                await agent.setup(environment)
            except ValueError as error:
                assert str(error) == "Invalid host-only setup proxy route"
                assert "a" * 64 not in str(error)
                rejected += 1
            else:
                raise AssertionError("Invalid setup proxy accepted")
        assert environment._persistent_env == original and not environment._exec_env_overlays.get()
        descriptor.unlink()
    result = {"state": "ACTUAL_DOCKER_ENVIRONMENT_SETUP_SCOPE_PORTS_PASSED_NO_INSTALL_OR_CONTAINER",
        "cases": summaries, "malformedRoutesRejectedBeforeInstall": rejected,
        "actualEnvironmentType": type(environment).__name__, "actualEnvironmentExecCalls": len(calls),
        "adapterSha256": hashlib.sha256((SOURCE / "scripts/bench/harbor_rc_gateway.py").read_bytes()).hexdigest(),
        "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "networkBlocked": True, "newProviderRequests": 0, "newContainers": 0,
        "limits": ["Real framework environment/setup ports with intercepted installer and Compose boundary; no package installation or real network qualification.",
                   "Supervisor separately verifies authenticated bridge reachability, actual inherited setup and bridge shutdown before the model phase."]}
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"state": result["state"], "scopeCases": len(summaries),
        "malformedRoutesRejected": rejected, "newProviderRequests": 0, "newContainers": 0}))


if __name__ == "__main__":
    asyncio.run(main())
