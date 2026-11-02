"""Offline public-framework port exercise; no real environment or model runs."""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import socket
import sys
import time
from pathlib import Path
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir()
    def deny_network(*_args, **_kwargs):
        raise AssertionError("This public-interface probe may not use the network")
    socket.socket.connect = deny_network
    from harbor.agents.factory import AgentFactory
    from harbor.agents.installed.openclaw import OpenClaw
    from harbor.models.agent.context import AgentContext
    from scripts.bench.harbor_rc_gateway import RcGatewayOpenClaw, validate_ticket, validate_receipt

    placeholder = "rc-placeholder-" + "b" * 64
    ticket = {"kind": "rc-harbor-relay-ticket-v1", "model": "openai/glm-5.3", "relayBaseUrl": "http://host.docker.internal:12345/v1",
              "placeholderCredential": placeholder, "officialWallMs": 60000, "deadlineAt": int(time.time() * 1000) + 60000,
              "tokenLimits": {"inputPerRequest": 262144, "outputPerRequest": 32768, "totalInput": 1048576, "totalOutput": 131072, "requests": 4}}
    receipt = {"scope": hashlib.sha256(placeholder.encode()).hexdigest(), "deadlineAt": ticket["deadlineAt"],
               "admittedRequests": 1, "wireDispatchAttempts": 1, "budget": {"requests": 1, "inFlightRequests": 0, "active": False,
               "halted": None, "committedInputTokens": 41, "committedOutputTokens": 2, "estimatedCommittedUsd": 0.000331}}
    ticket_file, receipt_file = args.output / "public-ticket.json", args.output / "controlled-receipt.json"
    ticket_file.write_text(json.dumps(ticket)); receipt_file.write_text(json.dumps(receipt))
    common = {"rc_artifact_path": args.artifact, "rc_relay_ticket": ticket_file, "rc_metering_receipt": receipt_file}
    traces = []
    class PortEnvironment:
        default_user = None
        def __init__(self, enabled):
            self.enabled = enabled
            self.calls = []
        async def exec(self, *, command, env=None, **kwargs):
            self.calls.append({"operation": "exec", "command": command, "env": env, **kwargs})
            stdout = "/work\n" if "pwd -P" in command else "/opt/pinned-node/lib/node_modules\n" if "npm root -g" in command else ""
            return SimpleNamespace(return_code=0, stdout=stdout, stderr="")
        async def upload_dir(self, source, target):
            self.calls.append({"operation": "upload_dir", "source": str(source), "target": target})
        async def upload_file(self, source, target):
            self.calls.append({"operation": "upload_file", "source": str(source), "target": target})
        async def download_file(self, source, target):
            self.calls.append({"operation": "download_file", "source": source, "target": str(target)})
            Path(target).write_text(json.dumps({"complete": True, "mode": "rc-on" if self.enabled else "rc-off",
                                              "originalRunId": "controlled-interface-stub-not-a-real-run"}))
    for enabled in (False, True):
        logs = args.output / ("on" if enabled else "off")
        agent = AgentFactory.create_agent_from_import_path("scripts.bench.harbor_rc_gateway:RcGatewayOpenClaw",
            logs_dir=logs, model_name="openai/glm-5.3", rc_enabled=enabled, **common)
        assert isinstance(agent, OpenClaw)
        assert agent.install.__func__ is OpenClaw.install
        environment, context = PortEnvironment(enabled), AgentContext()
        await agent.run("Keep this exact fictional instruction.", environment, context)
        assert context.n_input_tokens == 41 and context.n_output_tokens == 2 and context.cost_usd is None
        commands = [row["command"] for row in environment.calls if row["operation"] == "exec"]
        assert not any("--local" in command for command in commands)
        assert any("harbor-gateway-runner.mjs" in command for command in commands)
        assert not any("Keep this exact fictional instruction." in command for command in commands)
        assert all(row.get("env", {}).get("OPENAI_API_KEY", placeholder) == placeholder for row in environment.calls)
        traces.append({"arm": "on" if enabled else "off", "calls": environment.calls,
                       "controlledContext": context.model_dump(), "actualEnvironmentStarted": False})
    for action in (
        lambda: RcGatewayOpenClaw.preflight(kwargs=common, env={"OPENAI_API_KEY": "must-not-leak"}),
        lambda: AgentFactory.create_agent_from_import_path("scripts.bench.harbor_rc_gateway:RcGatewayOpenClaw",
            logs_dir=args.output / "rejected", model_name="openai/glm-5.3", extra_env={"ANTHROPIC_API_KEY": "must-not-leak"}, **common),
        lambda: validate_ticket({**ticket, "deadlineAt": 1}),
        lambda: validate_receipt(ticket, {**receipt, "scope": "foreign"}),
        lambda: validate_receipt(ticket, {**receipt, "budget": {**receipt["budget"], "halted": "BUDGET_USAGE_UNKNOWN"}}),
    ):
        try:
            action()
        except ValueError as error:
            assert "must-not-leak" not in str(error)
        else:
            raise AssertionError("Invalid configuration or metering receipt was accepted")
    result = {"state": "PINNED_PUBLIC_FACTORY_AND_PORTS_EXERCISED_OFFLINE", "frameworkVersion": __import__('harbor').__version__ if hasattr(__import__('harbor'), '__version__') else '0.23.0-pinned-source',
              "inheritedInstallUnchanged": True, "setupCalled": False, "realEnvironmentStarted": False,
              "realModelRequests": 0, "syntheticContextIsNotProviderUsage": True, "traces": traces,
              "limits": ["PortEnvironment supplies controlled exec/download results; this is not container or real terminal qualification.",
                         "Official task wall/resource identity, read-only artifact mounts, container relay reachability and trajectory need separate readiness checks."]}
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"state": result["state"], "realModelRequests": 0}))


if __name__ == "__main__":
    asyncio.run(main())
