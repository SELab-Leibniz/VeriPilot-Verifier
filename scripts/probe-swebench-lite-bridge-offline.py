"""Controlled public-port bridge checks; no real setup, container or model.

The actual installed custom agent/options/exec and scope methods run. Parent
Gateway setup/run and environment file/exec ports supply explicit fixture data.
Real Git and patch application are tested separately with fictional repositories.
"""
from __future__ import annotations
import argparse
import asyncio
import contextvars
import hashlib
import json
import socket
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); args.output.mkdir()
    socket.socket.connect = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("No network in bridge checks"))
    from harbor.environments.base import BaseEnvironment, ExecResult
    from harbor.models.agent.context import AgentContext
    from harbor.models.task.config import NetworkMode, NetworkPolicy
    from scripts.bench.harbor_rc_gateway import RcGatewayOpenClaw
    from scripts.bench.swebench_lite_gateway import SweBenchLiteGatewayOpenClaw
    base = "a" * 40; instruction = "Fictional public task, preserve this exact instruction.\r\n"
    instruction_sha = hashlib.sha256(instruction.encode()).hexdigest()
    helper = Path(__file__).with_name("bench") / "swebench-lite-workspace.mjs"
    helper_sha = hashlib.sha256(helper.read_bytes()).hexdigest()
    raw_patch = b"diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n"
    prefix = "/opt/miniconda3/envs/testbed"
    facts = {"prefix": prefix, "executable": prefix + "/bin/python", "version": "controlled fixture interpreter",
             "env": {"PATH": prefix + "/bin:/usr/bin:/bin", "CONDA_PREFIX": prefix, "CONDA_DEFAULT_ENV": "testbed"}}

    class PortEnvironment:
        scoped_exec_env = BaseEnvironment.scoped_exec_env
        _merge_env = BaseEnvironment._merge_env
        default_user = None
        def __init__(self):
            self.network_policy = NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=["host.docker.internal"])
            self._persistent_env = {"PATH": "/original/base/bin"}
            self._exec_env_overlays = contextvars.ContextVar("controlled-scope", default=())
            self.helper_sha = helper_sha; self.facts = facts; self.calls = []; self.network_modes = []
        async def set_network_policy(self, policy):
            self.network_modes.append(policy.network_mode.value); self.network_policy = policy
        async def exec(self, command, env=None, **_kwargs):
            merged = self._merge_env(env); self.calls.append({"command": command, "env": merged})
            assert command.startswith("set -o pipefail; ")
            command = command.removeprefix("set -o pipefail; ")
            stdout = (self.helper_sha + "  helper\n" if command.startswith("sha256sum ") else
                      json.dumps(self.facts) if command.startswith("conda run ") else "/testbed\n" if command == "pwd -P" else "")
            return ExecResult(return_code=0, stdout=stdout, stderr="")
        async def upload_file(self, *_args): pass
        async def download_file(self, source, target):
            if source.endswith("candidate.diff"): Path(target).write_bytes(raw_patch)
            elif source.endswith("prepare-result.json"):
                Path(target).write_text(json.dumps({"baseCommit": base, "originalBaseAndTrackedBytesPreserved": True,
                    "futureRefsAndObjectsRemoved": True, "allObjectsReachableFromBase": True, "reachableCommits": 1}))
            else:
                Path(target).write_text(json.dumps({"baseCommit": base, "businessIndexUnchanged": True,
                    "automaticCommit": False, "bytes": len(raw_patch), "sha256": hashlib.sha256(raw_patch).hexdigest()}))

    setup_calls = 0; run_calls = 0; parent_fails = False; setup_fails = False
    async def controlled_setup(self, _environment):
        nonlocal setup_calls
        assert _environment.network_policy.network_mode == NetworkMode.PUBLIC
        setup_calls += 1; self.logs_dir.mkdir(parents=True, exist_ok=True)
        if setup_fails: raise RuntimeError("controlled installation failure")
    async def controlled_run(self, public_instruction, environment, context):
        nonlocal run_calls
        run_calls += 1
        assert public_instruction == instruction
        assert environment._merge_env(None)["CONDA_PREFIX"] == prefix
        context.metadata = {"controlledParentRun": True}
        if parent_fails: raise RuntimeError("controlled runtime failure")

    def agent(label, enabled=True, **extra):
        return SweBenchLiteGatewayOpenClaw(logs_dir=args.output / label, model_name="openai/glm-5.3",
            rc_artifact_path=args.output, rc_relay_ticket=args.output / "unused-ticket", rc_metering_receipt=args.output / "unused-receipt",
            rc_instance_id="fictional__repo-1", rc_base_commit=base, rc_problem_statement_sha256=instruction_sha,
            rc_enabled=enabled, rc_official_wall_ms=1800000, **extra)

    checks = []
    with patch.object(RcGatewayOpenClaw, "setup", controlled_setup), patch.object(RcGatewayOpenClaw, "run", controlled_run):
        for enabled in [False, True]:
            current = agent("on" if enabled else "off", enabled); env = PortEnvironment()
            await current.setup(env); context = AgentContext(n_input_tokens=51, n_output_tokens=7)
            assert env.network_modes == ["public", "allowlist"]
            await current.run(instruction, env, context)
            prediction = json.loads((current.logs_dir / "prediction.jsonl").read_text())
            assert prediction == {"instance_id": "fictional__repo-1", "model_name_or_path": "openai/glm-5.3", "model_patch": raw_patch.decode()}
            assert env._merge_env(None) == env._persistent_env and not env._exec_env_overlays.get()
            assert context.n_input_tokens == 51 and context.n_output_tokens == 7
            assert context.metadata["swebenchLite"]["officialGraderRunHere"] is False
            checks.append({"case": "on" if enabled else "off", "predictionExact": True, "scopeRestored": True, "allRoleContextUnchanged": True})
        current = agent("wrong-instruction");env = PortEnvironment();await current.setup(env);prior = run_calls
        try: await current.run("changed public input", env, AgentContext())
        except ValueError: pass
        else: raise AssertionError("Instruction identity accepted")
        assert run_calls == prior
        checks.append({"case":"instruction_hash_rejection_before_parent", "passed":True})
        current = agent("failed-runtime"); env = PortEnvironment(); await current.setup(env)
        context = AgentContext(); parent_fails = True; prior = run_calls
        try: await current.run(instruction, env, context)
        except RuntimeError as error: assert str(error) == "controlled runtime failure"
        else: raise AssertionError("Runtime failure hidden")
        assert not (current.logs_dir / "prediction.jsonl").exists()
        try: await current.collect_prediction(env, context, partial=True, owner_confirmed_quiescence=False)
        except ValueError: pass
        else: raise AssertionError("Unfrozen workspace was collected")
        await current.collect_prediction(env, context, partial=True, owner_confirmed_quiescence=True)
        assert run_calls == prior + 1 and context.metadata["swebenchLite"]["partialRuntimeResult"]
        assert context.metadata["swebenchLiteRuntimeFailure"]["type"] == "RuntimeError"
        assert env._merge_env(None) == env._persistent_env
        parent_fails = False
        checks.append({"case":"partial_artifact_after_owner_barrier_preserves_runtime_failure_no_model_rerun", "passed":True})
        original_path = args.output / "public-original-instruction.md"; original_path.write_bytes(instruction.encode())
        current = agent("newline-transport", rc_original_instruction_path=original_path)
        env = PortEnvironment(); await current.setup(env)
        await current.run(instruction.replace("\r\n", "\n"), env, AgentContext())
        checks.append({"case":"Harbor_newline_transport_restores_exact_original_bytes_before_parent", "passed":True})
        current = agent("failed-install"); env = PortEnvironment(); setup_fails = True
        try: await current.setup(env)
        except RuntimeError as error: assert str(error) == "controlled installation failure"
        else: raise AssertionError("Installation failure hidden")
        assert env.network_modes == ["public", "allowlist"] and env.network_policy.allowed_hosts == ["host.docker.internal"]
        assert getattr(current, "_lite_workspace_qualified", False) is False
        setup_fails = False
        checks.append({"case":"installer_failure_restores_relay_only_policy_and_preserves_original_error", "passed":True})
        for label in ["public-network", "wrong-conda", "wrong-helper"]:
            current = agent(label); env = PortEnvironment(); prior = run_calls
            if label == "public-network": env.network_policy = NetworkPolicy(network_mode=NetworkMode.PUBLIC)
            elif label == "wrong-conda": env.facts = {**facts, "prefix":"/opt/miniconda3"}
            else: env.helper_sha = "0" * 64
            try: await current.setup(env)
            except ValueError: pass
            else: raise AssertionError("Invalid setup boundary accepted")
            try: await current.run(instruction, env, AgentContext())
            except ValueError: pass
            else: raise AssertionError("Incomplete setup admitted a model run")
            assert run_calls == prior
            checks.append({"case":label+"_fails_before_model", "passed":True})
    result = {"state":"CONTROLLED_LITE_BRIDGE_PORT_CONTRACTS_PASSED", "checks":checks,
        "setupBoundaryCalls":setup_calls,"controlledParentRunCalls":run_calls,
        "sourceHashes":{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [helper,Path(__file__).with_name('bench')/'swebench_lite_gateway.py']},
        "networkBlocked":True,"newProviderRequests":0,"newContainers":0,
        "limits":"Parent setup/run and remote operations supplied fixture results. No actual image, Conda interpreter or Gateway settlement is claimed; use actual-image probe separately."}
    (args.output / "result.json").write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({"state":result['state'],"checks":len(checks),"newProviderRequests":0,"newContainers":0}))


if __name__ == "__main__":asyncio.run(main())
