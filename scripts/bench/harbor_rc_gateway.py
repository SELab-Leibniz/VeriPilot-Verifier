"""RC-owned public Harbor custom agent; upstream credentials stay outside Docker.

Import path: scripts.bench.harbor_rc_gateway:RcGatewayOpenClaw
The pinned framework, host installation, task and grader are never rewritten.
"""
from __future__ import annotations

import hashlib
import asyncio
import json
import math
import re
import shlex
import time
from pathlib import Path
from typing import Any, Mapping, Literal
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from pydantic import Field
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.openclaw import OpenClaw, OpenClawOptions, OPENCLAW_AGENT_SETUP_TIMEOUT_SEC, openclaw_session_jsonl_to_atif_steps
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory, Agent, FinalMetrics
from harbor.utils.trajectory_utils import format_trajectory_json

PINNED_HOST = "2026.7.1-2"
AUTH_NAME = re.compile(r"api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|credential", re.I)
SETUP_PROXY = re.compile(r"http://rc-setup:[a-fA-F0-9]{64}@host\.docker\.internal:([1-9][0-9]{0,4})")


def reject_container_auth(env: Mapping[str, Any] | None) -> None:
    # Inspect names only. Never echo values into exceptions, logs or Docker args.
    if any(value and AUTH_NAME.search(name) for name, value in (env or {}).items()):
        raise ValueError("Container upstream auth is forbidden; use the external relay controller")


def setup_proxy_env(value: Any) -> dict[str, str]:
    route = SETUP_PROXY.fullmatch(value) if isinstance(value, str) else None
    if route is None or int(route[1]) > 65535:
        # The disposable bridge capability must not be echoed into errors.
        raise ValueError("Invalid host-only setup proxy route")
    bypass = "localhost,127.0.0.1,host.docker.internal"
    return {"http_proxy": value, "https_proxy": value,
            "HTTP_PROXY": value, "HTTPS_PROXY": value,
            "no_proxy": bypass, "NO_PROXY": bypass}


def validate_ticket(ticket: dict[str, Any], now_ms: int | None = None) -> None:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if (ticket.get("kind") != "rc-harbor-relay-ticket-v1"
            or ticket.get("model") not in {"openai/glm-5.3", "openai/glm-5.3-flash"}
            or not re.fullmatch(r"rc-placeholder-[a-f0-9]{64}", ticket.get("placeholderCredential", ""))
            or not isinstance(ticket.get("deadlineAt"), int) or ticket["deadlineAt"] <= now_ms
            or not isinstance(ticket.get("officialWallMs"), int) or ticket["officialWallMs"] < 1000):
        raise ValueError("Invalid or expired public relay ticket")
    route = urlparse(ticket.get("relayBaseUrl", ""))
    if (route.scheme != "http" or route.hostname not in {"127.0.0.1", "host.docker.internal"}
            or not route.port or route.path != "/v1" or route.username or route.password or route.query or route.fragment):
        raise ValueError("Unqualified container relay route")
    limits = ticket.get("tokenLimits", {})
    if any(not isinstance(limits.get(key), int) or limits[key] < 1
           for key in ("inputPerRequest", "outputPerRequest", "totalInput", "totalOutput", "requests")):
        raise ValueError("Missing finite shared token/request limits")


def validate_receipt(ticket: dict[str, Any], receipt: dict[str, Any]) -> dict[str, Any]:
    expected = hashlib.sha256(ticket["placeholderCredential"].encode()).hexdigest()
    budget = receipt.get("budget", {})
    if (receipt.get("scope") != expected or receipt.get("deadlineAt") != ticket["deadlineAt"]
            or budget.get("inFlightRequests") != 0 or budget.get("active") is not False or budget.get("halted") is not None
            or receipt.get("admittedRequests") != budget.get("requests")
            or receipt.get("wireDispatchAttempts") != budget.get("requests")
            or any(not isinstance(budget.get(key), int) or budget[key] < 0
                   for key in ("requests", "committedInputTokens", "committedOutputTokens"))):
        raise ValueError("External metering receipt is unsettled, unknown, or belongs to a different trial")
    return budget


class RcGatewayOptions(OpenClawOptions):
    rc_policy_path: Path | None = None
    rc_policy_profile: Literal["full", "baseline"] = "full"
    rc_fault: dict[str, Any] | None = None
    rc_artifact_path: Path = Field(description="Frozen local OpenClaw RC artifact, supplied through public upload ports")
    rc_relay_ticket: Path | None = Field(default=None, description="Static public ticket for offline probes; mutually exclusive with controller descriptor")
    rc_controller_descriptor: Path | None = Field(default=None, description="Host-only /start endpoint, control token and optional disposable setupProxyUrl; never uploaded")
    rc_metering_receipt: Path = Field(description="Host-side receipt written by the external metering controller")
    rc_artifact_remote_path: str | None = Field(default=None, description="Optional public read-only artifact mount target; upload mode is a development fallback")
    rc_enabled: bool = True
    rc_official_wall_ms: int = Field(default=750000, ge=1000, description="Frozen official agent-phase timeout; first TB dev is 750000ms")


class RcGatewayOpenClaw(OpenClaw):
    # Trial resolves the outer setup allowance from the class, independently
    # of OpenClaw's per-command installer timeout. Match our qualified 1200s
    # setup window for both arms; this is outside the shared inference clock.
    DEFAULT_SETUP_TIMEOUT_SEC = OPENCLAW_AGENT_SETUP_TIMEOUT_SEC
    capabilities = AgentCapabilities(atif=True, skills=False, mcp_servers=False)
    options_model = RcGatewayOptions
    options: RcGatewayOptions

    @staticmethod
    def name() -> str:
        return "rc-gateway-openclaw"

    @classmethod
    def preflight(cls, *, kwargs: dict[str, Any], env: Mapping[str, str] | None = None) -> None:
        reject_container_auth(env)
        super().preflight(kwargs=kwargs, env=env)

    def __init__(self, *args: Any, **kwargs: Any):
        reject_container_auth(kwargs.get("extra_env"))
        kwargs.setdefault("version", PINNED_HOST)
        super().__init__(*args, **kwargs)
        if (self.options.rc_relay_ticket is None) == (self.options.rc_controller_descriptor is None):
            raise ValueError("Supply exactly one controller descriptor or static offline ticket")
        if self.version() != PINNED_HOST or self.model_name not in {"openai/glm-5.3", "openai/glm-5.3-flash"}:
            raise ValueError("This prototype pins OpenClaw 2026.7.1-2 and openai/glm-5.3")
        if (self.options.openclaw_config or self.options.config or self.options.thinking not in {None, "off"}
                or self.options.prompt_template_path or self.options.timeout or self.options.failover_retries is not None
                or self.options.disable_web_search or self.mcp_servers or self.skills_dir or self.load_trajectory):
            raise ValueError("Arbitrary host overlays or model changes are not qualified by this prototype")
        # Installation logic stays inherited. Optional setup egress uses only
        # the public environment scope and never persists into the task phase.

    async def setup(self, environment: BaseEnvironment) -> None:
        proxy_env = None
        if self.options.rc_controller_descriptor is not None:
            descriptor_path = self.options.rc_controller_descriptor.resolve(strict=True)
            if descriptor_path.is_relative_to(self.logs_dir.resolve()):
                raise ValueError("Controller descriptor must stay outside mounted agent logs")
            descriptor = json.loads(descriptor_path.read_text())
            if not isinstance(descriptor, dict):
                raise ValueError("Invalid host-only phase controller descriptor")
            if "setupProxyUrl" in descriptor:
                proxy_env = setup_proxy_env(descriptor["setupProxyUrl"])
        if proxy_env is None:
            await super().setup(environment)
        else:
            with environment.scoped_exec_env(proxy_env):
                await super().setup(environment)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        phase_started_at = int(time.time() * 1000)
        if self.options.rc_controller_descriptor is not None:
            descriptor_path = self.options.rc_controller_descriptor.resolve(strict=True)
            if descriptor_path.is_relative_to(self.logs_dir.resolve()):
                raise ValueError("Controller descriptor must stay outside mounted agent logs")
            descriptor = json.loads(descriptor_path.read_text())
            start_url, token = descriptor.get("startUrl"), descriptor.get("controlToken")
            route = urlparse(start_url or "")
            official_wall_ms = self.options.rc_official_wall_ms
            if (descriptor.get("kind") != "rc-harbor-controller-v1" or route.scheme != "http" or route.hostname != "127.0.0.1" or not route.port or route.path != "/start"
                    or route.query or route.fragment or route.username or not isinstance(token, str) or len(token) < 32
                    or not isinstance(official_wall_ms, int) or official_wall_ms < 1000):
                raise ValueError("Invalid host-only phase controller descriptor")
            request = Request(start_url, data=json.dumps({"phaseStartedAt": phase_started_at, "officialWallMs": official_wall_ms,
                "rcEnabled": self.options.rc_enabled}).encode(),
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=5) as response:
                activated = json.load(response)
            ticket = activated.get("ticket", activated)
            if ticket.get("deadlineAt", 0) > phase_started_at + official_wall_ms:
                raise ValueError("Phase controller extended the original official wall deadline")
        else:
            ticket = json.loads(self.options.rc_relay_ticket.read_text())
        validate_ticket(ticket)
        if ticket["model"] != self.model_name:
            raise ValueError("Model ticket differs from the selected model")
        artifact = self.options.rc_artifact_path.resolve(strict=True)
        package = json.loads((artifact / "package.json").read_text())
        if package.get("name") != "runtime-corrector-openclaw":
            raise ValueError("Expected a frozen built RC OpenClaw artifact")
        hashes: dict[str, str] = {}
        for file in sorted(artifact.rglob("*")):
            if file.is_symlink():
                raise ValueError("Frozen artifact may not contain symlinks")
            if file.is_file():
                hashes[str(file.relative_to(artifact))] = hashlib.sha256(file.read_bytes()).hexdigest()
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        remote = "/logs/agent/rc-runtime"
        child_env = {"OPENAI_API_KEY": ticket["placeholderCredential"], "OPENCLAW_SKIP_CRON": "1"}
        await self.exec_as_agent(environment, f"mkdir -p {shlex.quote(remote)}", env=child_env)
        project = (await self.exec_as_agent(environment, "pwd -P", env=child_env)).stdout.strip()
        if not project.startswith("/") or "\n" in project:
            raise ValueError("The actual environment did not expose one absolute workspace")
        npm = (await self.exec_as_agent(environment, '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && npm root -g', env=child_env)).stdout.strip()
        if not npm.startswith("/") or "\n" in npm:
            raise ValueError("Cannot locate the inherited pinned host installation")
        remote_plugin = self.options.rc_artifact_remote_path or remote + "/plugin"
        if not remote_plugin.startswith("/") or ".." in Path(remote_plugin).parts:
            raise ValueError("Invalid read-only artifact mount target")
        if self.options.rc_artifact_remote_path is None:
            await environment.upload_dir(artifact, remote_plugin)
        for name in ("harbor-gateway-runner.mjs", "harbor-gateway-controller.mjs", "prepare-harbor-workspace.mjs", "baseline-bench-fault.mjs"):
            await environment.upload_file(Path(__file__).with_name(name), remote + "/" + name)
        source_root = Path(__file__).resolve().parents[2]
        for name in ("harbor-evaluation.yaml", "harbor-document-review.md"):
            selected = self.options.rc_policy_path if name == "harbor-evaluation.yaml" and self.options.rc_policy_path else source_root / "config" / name
            await environment.upload_file(selected, remote + "/" + name)
        instruction_file = self.logs_dir / "rc-original-instruction.txt"
        instruction_file.write_text(instruction)
        await environment.upload_file(instruction_file, remote + "/instruction.txt")
        spec = {"hostRoot": npm + "/openclaw", "projectRoot": project, "pluginRoot": remote_plugin,
                "outputRoot": remote + "/host-run", "ticket": ticket, "rcEnabled": self.options.rc_enabled,
                "instructionPath": remote + "/instruction.txt", "resultPath": remote + "/result.json", "artifactHashes": hashes,
                "policyPath": remote + "/harbor-evaluation.yaml", "criteriaPath": remote + "/harbor-document-review.md",
                "nativeTranscriptOutput": "/logs/agent/openclaw.session.jsonl",
                "policyProfile": self.options.rc_policy_profile, "fault": self.options.rc_fault}
        spec_file = self.logs_dir / "rc-public-run.json"
        spec_file.write_text(json.dumps(spec, indent=2) + "\n")
        await environment.upload_file(spec_file, remote + "/run.json")
        command = '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && node ' + shlex.quote(remote + "/harbor-gateway-runner.mjs") + " --manifest " + shlex.quote(remote + "/run.json")
        remaining = ticket["deadlineAt"] - int(time.time() * 1000)
        if remaining <= 0:
            raise TimeoutError("Original shared task deadline expired before Gateway dispatch")
        await self.exec_as_agent(environment, command, env=child_env, timeout_sec=math.ceil(remaining / 1000))
        result_file = self.logs_dir / "rc-gateway-result.json"
        await environment.download_file(remote + "/result.json", result_file)
        result = json.loads(result_file.read_text())
        if not result.get("complete") or result.get("mode") != ("rc-on" if self.options.rc_enabled else "rc-off"):
            raise ValueError("Gateway/RC did not settle before Harbor collection")
        native_log = self.logs_dir / "openclaw.session.jsonl"
        expected_native_sha = result.get("nativeTranscript", {}).get("sha256")
        if not native_log.is_file() or hashlib.sha256(native_log.read_bytes()).hexdigest() != expected_native_sha:
            await environment.download_file("/logs/agent/openclaw.session.jsonl", native_log)
        # The last streamed response can precede the external ledger write.
        # Wait only within the same official deadline; unknown usage stops now.
        while True:
            if int(time.time() * 1000) >= ticket["deadlineAt"]:
                raise TimeoutError("Original official deadline expired before metering settlement")
            try:
                receipt = json.loads(self.options.rc_metering_receipt.read_text())
            except FileNotFoundError:
                await asyncio.sleep(0.05)
                continue
            if (receipt.get("scope") != hashlib.sha256(ticket["placeholderCredential"].encode()).hexdigest()
                    or receipt.get("deadlineAt") != ticket["deadlineAt"]):
                raise ValueError("External receipt belongs to a different scope/deadline")
            if receipt.get("budget", {}).get("halted") is not None:
                raise ValueError("External provider usage is halted/unknown; keep the original reservation")
            if (receipt.get("budget", {}).get("inFlightRequests") != 0 or receipt.get("budget", {}).get("active") is not False
                    or receipt.get("queued", 0) != 0):
                await asyncio.sleep(0.05)
                continue
            budget = validate_receipt(ticket, receipt)
            break
        context.n_input_tokens = budget["committedInputTokens"]
        context.n_output_tokens = budget["committedOutputTokens"]
        context.metadata = {**(context.metadata or {}), "rcGateway": result,
                            "rcArtifactHashes": hashes, "meteringScope": receipt["scope"],
                            "referenceEstimateUsd": budget.get("estimatedCommittedUsd"), "actualAccountBill": "unknown",
                            "meteringCoverage": "one external original/private-review/correction ledger",
                            "qualification": "prototype; official wall/resource/mount/trajectory readiness separately required"}
        # Reference estimates are not official billed cost_usd. The original
        # framework retains ownership of artifact collection and grading.

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Use actual host JSONL and the pinned framework converter. Never
        # synthesize a successful CLI envelope or overwrite all-role totals
        # with the business session's smaller usage counters.
        result_path = self.logs_dir / "rc-gateway-result.json"
        source = self.logs_dir / "openclaw.session.jsonl"
        def unavailable(reason: str) -> None:
            context.metadata = {**(context.metadata or {}), "trajectoryUnavailable": {
                "reason": reason, "provenance": "failed or unfinished agent run; preserve the original official failure",
                "successfulResultPath": str(result_path), "nativeTranscriptPath": str(source),
                "successfulResultPresent": result_path.is_file(), "nativeTranscriptPresent": source.is_file(),
                "tokens": "External phase ledger remains authoritative; missing trace is not zero usage",
            }}
        try:
            result = json.loads(result_path.read_text())
        except FileNotFoundError:
            unavailable("SUCCESSFUL_GATEWAY_RESULT_MISSING")
            return
        if not isinstance(result, dict) or result.get("complete") is not True or not isinstance(result.get("sessionId"), str):
            raise ValueError("Existing successful Gateway result has an invalid structure")
        identity = result.get("nativeTranscript")
        if not isinstance(identity, dict):
            raise ValueError("Existing Gateway transcript identity has an invalid structure")
        expected = identity.get("sha256")
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError("Existing Gateway transcript identity is invalid")
        try:
            transcript_bytes = source.read_bytes()
        except FileNotFoundError:
            unavailable("NATIVE_TRANSCRIPT_MISSING")
            return
        if hashlib.sha256(transcript_bytes).hexdigest() != expected:
            raise ValueError("Actual native session transcript is missing or changed")
        instruction = (self.logs_dir / "rc-original-instruction.txt").read_text()
        steps = openclaw_session_jsonl_to_atif_steps(source, instruction=instruction, model_name=self.model_name or "")
        if not steps:
            raise ValueError("Actual native session contains no exportable trajectory steps")
        trajectory = Trajectory(schema_version="ATIF-v1.7", session_id=result["sessionId"],
            agent=Agent(name="openclaw", version=self.version() or "unknown", model_name=self.model_name), steps=steps,
            final_metrics=FinalMetrics(total_prompt_tokens=context.n_input_tokens, total_completion_tokens=context.n_output_tokens,
                                      total_steps=len(steps)))
        (self.logs_dir / "trajectory.json").write_text(format_trajectory_json(trajectory.to_json_dict()))
        context.metadata = {**(context.metadata or {}), "trajectorySourceSha256": expected,
            "trajectoryCoverage": "actual business session including correction; token totals include all external-ledger private work"}
