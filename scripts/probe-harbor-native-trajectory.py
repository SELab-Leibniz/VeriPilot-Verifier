"""Replay the preserved real fictional Gateway run into the pinned ATIF port.

No provider is called, no transcript record is invented, and source JSONL is
unchanged. The original task/repair tool identities must survive conversion.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
import socket
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--gateway-result", type=Path, required=True)
    parser.add_argument("--settlement", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); args.output.mkdir()
    socket.socket.connect = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("No network in trajectory replay"))
    from scripts.bench.harbor_rc_gateway import RcGatewayOpenClaw
    from harbor.models.agent.context import AgentContext
    actual = json.loads(args.gateway_result.read_text()); settled = json.loads(args.settlement.read_text())
    host = Path(actual["isolatedState"]).resolve(); entries = json.loads((host / "sessions.json").read_text())
    entry = entries[actual["sessionKey"]]; assert entry["sessionId"] == actual["sessionId"]
    source = Path(entry["sessionFile"]).resolve(strict=True); assert source.is_relative_to(host)
    raw = source.read_bytes(); sha = hashlib.sha256(raw).hexdigest()
    records = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    users = [row["message"] for row in records if row.get("type") == "message" and row.get("message", {}).get("role") == "user"]
    content = users[0]["content"]; instruction = content if isinstance(content, str) else "".join(x.get("text", "") for x in content if x.get("type") == "text")
    tool_ids = [block["id"] for row in records if row.get("type") == "message" and row.get("message", {}).get("role") == "assistant"
                for block in row["message"].get("content", []) if isinstance(block, dict) and block.get("type") == "toolCall"]
    assert tool_ids, "Expected actual business tool calls, not a manufactured envelope"
    logs = args.output / "agent"; logs.mkdir()
    shutil.copyfile(source, logs / "openclaw.session.jsonl")
    (logs / "rc-original-instruction.txt").write_text(instruction)
    assert actual["complete"] is True
    (logs / "rc-gateway-result.json").write_text(json.dumps({"complete": actual["complete"], "sessionId": actual["sessionId"], "nativeTranscript": {"sha256": sha}}))
    agent = RcGatewayOpenClaw(logs_dir=logs, model_name="openai/glm-5.3", rc_artifact_path=args.output,
        rc_relay_ticket=args.output / "unused-public-ticket", rc_metering_receipt=args.output / "unused-receipt")
    batch = settled["lastBatch"]
    assert Path(batch["root"]).resolve() == args.gateway_result.parent.resolve()
    context = AgentContext(n_input_tokens=batch["input"], n_output_tokens=batch["output"])
    agent.populate_context_post_run(context)
    trajectory = json.loads((logs / "trajectory.json").read_text())
    converted = [tool["tool_call_id"] for step in trajectory["steps"] for tool in (step.get("tool_calls") or [])]
    assert converted == tool_ids
    assert source.read_bytes() == raw
    assert context.n_input_tokens == batch["input"] and context.n_output_tokens == batch["output"] and context.cost_usd is None
    missing_checks = []
    for kind in ("missing-result", "missing-transcript", "wrong-hash", "invalid-structure"):
        case_logs = args.output / kind; case_logs.mkdir()
        case = RcGatewayOpenClaw(logs_dir=case_logs, model_name="openai/glm-5.3", rc_artifact_path=args.output,
            rc_relay_ticket=args.output / "unused-public-ticket", rc_metering_receipt=args.output / "unused-receipt")
        value = {"complete": True, "sessionId": actual["sessionId"], "nativeTranscript": {"sha256": sha}}
        if kind != "missing-result":
            if kind == "wrong-hash": value["nativeTranscript"]["sha256"] = "0" * 64
            if kind == "invalid-structure": value = {"complete": False}
            (case_logs / "rc-gateway-result.json").write_text(json.dumps(value))
        if kind in {"wrong-hash", "invalid-structure"}: shutil.copyfile(source, case_logs / "openclaw.session.jsonl")
        case_context = AgentContext(metadata={"originalFailure": "unchanged controlled failure marker"})
        try:
            case.populate_context_post_run(case_context)
        except ValueError:
            assert kind in {"wrong-hash", "invalid-structure"}
            missing_checks.append({"case": kind, "strictFailureRetained": True})
        else:
            assert kind in {"missing-result", "missing-transcript"}
            assert case_context.metadata["originalFailure"] == "unchanged controlled failure marker"
            assert case_context.metadata["trajectoryUnavailable"]["reason"]
            assert case_context.n_input_tokens is None and not (case_logs / "trajectory.json").exists()
            missing_checks.append({"case": kind, "originalFailurePreserved": True, "noFabricatedTrajectoryOrUsage": True})
    result = {"state": "ACTUAL_NATIVE_BUSINESS_AND_CORRECTION_TRAJECTORY_EXPORTED_WITH_PINNED_CONVERTER",
        "sourceResult": str(args.gateway_result), "sourceSession": str(source), "sourceSha256": sha, "sourceBytesUnchanged": True,
        "actualSessionId": actual["sessionId"], "stepCount": len(trajectory["steps"]), "actualToolCalls": len(tool_ids),
        "toolCallIdsPreserved": True, "trajectory": "agent/trajectory.json", "newProviderRequests": 0,
        "failedRunProvenanceControls": missing_checks,
        "allRoleContextPreserved": {"input": context.n_input_tokens, "output": context.n_output_tokens},
        "limitation": "Existing real fictional Gateway003 history validates conversion; current container runner's future actual task export still requires end-to-end pilot evidence."}
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"state": result["state"], "stepCount": result["stepCount"], "actualToolCalls": len(tool_ids), "newProviderRequests": 0}))


if __name__ == "__main__": main()
