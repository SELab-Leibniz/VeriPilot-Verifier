"""Thin SWE-bench Lite bridge over the installed RC OpenClaw Gateway.

Only public instance identity/base/instruction hashes belong here. The official
dataset/eval script/test groups stay in the separate unchanged grader process.
"""
from __future__ import annotations

import hashlib
import json
import shlex
from pathlib import Path
from typing import Any

from pydantic import Field
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import NetworkMode, NetworkPolicy
from scripts.bench.harbor_rc_gateway import RcGatewayOpenClaw, RcGatewayOptions

WORKSPACE = "/testbed"
REMOTE = "/logs/agent/rc-lite"
HELPER = "/opt/rc-lite/swebench-lite-workspace.mjs"
PRIVATE_GRADER_PATHS = ["/eval.sh", "/patch.diff", "/test.patch", "/tests/test.sh",
                        "/root/eval.sh", "/root/patch.diff", "/root/test.patch"]


class SweBenchLiteGatewayOptions(RcGatewayOptions):
    rc_instance_id: str = Field(pattern=r"^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-[0-9]+$")
    rc_base_commit: str = Field(pattern=r"^[a-f0-9]{40}$")
    rc_problem_statement_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    rc_original_instruction_path: Path | None = Field(default=None,
        description="Frozen host-only public instruction bytes; restores Harbor's universal-newline transport only")
    rc_conda_environment: str = Field(default="testbed", pattern=r"^[A-Za-z0-9_.-]+$")


class SweBenchLiteGatewayOpenClaw(RcGatewayOpenClaw):
    options_model = SweBenchLiteGatewayOptions
    options: SweBenchLiteGatewayOptions

    @staticmethod
    def name() -> str:
        return "rc-swebench-lite-openclaw"

    def _require_agent_network_boundary(self, environment: BaseEnvironment) -> None:
        policy = environment.network_policy
        if policy.network_mode != NetworkMode.ALLOWLIST or set(policy.allowed_hosts) != {"host.docker.internal"}:
            raise ValueError("Lite agent requires the declared relay-host-only network policy")

    def business_exec_environment(self) -> dict[str, str]:
        if not hasattr(self, "_lite_business_env"):
            raise ValueError("Actual testbed interpreter has not been qualified")
        return dict(self._lite_business_env)

    async def _workspace_operation(self, environment: BaseEnvironment, operation: str,
                                   timeout_sec: int = 120) -> dict[str, Any]:
        helper = Path(__file__).with_name("swebench-lite-workspace.mjs")
        expected = hashlib.sha256(helper.read_bytes()).hexdigest()
        observed = await self.exec_as_agent(environment, "sha256sum " + shlex.quote(HELPER), timeout_sec=10)
        if not (observed.stdout or "").startswith(expected + " "):
            raise ValueError("Read-only Lite workspace helper does not match the frozen source")
        spec = {"projectRoot": WORKSPACE, "baseCommit": self.options.rc_base_commit,
                "forbiddenPaths": PRIVATE_GRADER_PATHS, "maxPatchBytes": 8 * 1024 * 1024}
        local_spec = self.logs_dir / ("lite-" + operation + "-spec.json")
        local_spec.write_text(json.dumps(spec) + "\n")
        await self.exec_as_agent(environment, "mkdir -p " + REMOTE)
        await environment.upload_file(local_spec, REMOTE + "/spec.json")
        remote_result = REMOTE + "/" + operation + "-result.json"
        command = ('. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 >/dev/null && node ' + shlex.quote(HELPER)
            + " --operation " + operation + " --spec " + REMOTE + "/spec.json --result " + remote_result)
        if operation == "collect":
            command += " --patch " + REMOTE + "/candidate.diff"
        await self.exec_as_agent(environment, command, timeout_sec=timeout_sec)
        local = self.logs_dir / ("lite-" + operation + "-result.json")
        await environment.download_file(remote_result, local)
        result = json.loads(local.read_text())
        if result.get("baseCommit") != self.options.rc_base_commit:
            raise ValueError("Lite workspace result belongs to a different base")
        return result

    async def setup(self, environment: BaseEnvironment) -> None:
        self._lite_workspace_qualified = False
        self._require_agent_network_boundary(environment)
        # Harbor's transparent allowlist sniffs an explicit proxy CONNECT's
        # destination hostname before it reaches the host bridge. Keep that
        # interception off during the unchanged installer only. No model/task
        # runs here; the original scoped authenticated setup proxy stays used.
        original_policy = environment.network_policy.model_copy(deep=True)
        setup_error = None
        await environment.set_network_policy(NetworkPolicy(network_mode=NetworkMode.PUBLIC))
        try:
            await super().setup(environment)
        except BaseException as error:
            setup_error = error
            raise
        finally:
            try:
                await environment.set_network_policy(original_policy)
            except Exception as restore_error:
                if setup_error is not None:
                    setup_error.add_note("Failed to restore the relay-only network after installer failure; model remains forbidden")
                    raise setup_error from restore_error
                raise ValueError("Failed to restore the relay-only network after installation") from restore_error
        self._require_agent_network_boundary(environment)
        (self.logs_dir / "lite-setup-network.json").write_text(json.dumps({
            "setupMode": "public", "scope": "original inherited installer only; authenticated setup proxy still scoped",
            "restoredMode": original_policy.network_mode.value, "restoredHosts": original_policy.allowed_hosts,
            "modelPhasePublicNetworkAllowed": False, "sameForBothArms": True}, indent=2) + "\n")
        working = await self.exec_as_agent(environment, "pwd -P", timeout_sec=10)
        if (working.stdout or "").strip() != WORKSPACE:
            raise ValueError("Lite agent working directory is not the frozen testbed workspace")
        # Query actual activation facts without reading any task eval_script.
        # No silent fallback to the base interpreter is permitted.
        code = ('import json,os,sys; print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,'
            '"version":sys.version,"env":{k:os.environ[k] for k in '
            '["PATH","CONDA_PREFIX","CONDA_DEFAULT_ENV","CONDA_SHLVL","LD_LIBRARY_PATH","PYTHONPATH","PYTHONHOME"] if k in os.environ}}))')
        response = await self.exec_as_agent(environment, "conda run --no-capture-output -n "
            + shlex.quote(self.options.rc_conda_environment) + " python -c " + shlex.quote(code), timeout_sec=30)
        facts = json.loads(response.stdout or "")
        prefix, executable, env = facts.get("prefix"), facts.get("executable"), facts.get("env", {})
        if (not isinstance(prefix, str) or not prefix.startswith("/") or Path(prefix).name != self.options.rc_conda_environment
                or not isinstance(executable, str) or not executable.startswith(prefix + "/bin/")
                or env.get("CONDA_PREFIX") != prefix or not isinstance(env.get("PATH"), str)
                or prefix + "/bin" not in env["PATH"].split(":")):
            raise ValueError("Actual project Conda environment is missing or inconsistent")
        self._lite_business_env = {key: value for key, value in env.items() if isinstance(value, str)}
        (self.logs_dir / "lite-business-environment.json").write_text(json.dumps({
            "executable": executable, "prefix": prefix, "version": facts.get("version"),
            "activationKeys": sorted(self._lite_business_env), "sameForBothArms": True,
            "source": "actual conda run facts; not hidden evaluator instructions"}, indent=2) + "\n")
        boundary = await self._workspace_operation(environment, "prepare")
        if (boundary.get("originalBaseAndTrackedBytesPreserved") is not True
                or boundary.get("futureRefsAndObjectsRemoved") is not True
                or boundary.get("allObjectsReachableFromBase") is not True or boundary.get("reachableCommits") != 1):
            raise ValueError("Lite base-only workspace boundary did not pass")
        self._lite_workspace_qualified = True

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if getattr(self, "_lite_workspace_qualified", False) is not True:
            raise ValueError("Lite workspace setup did not complete qualification")
        if self.options.rc_original_instruction_path is not None:
            source = self.options.rc_original_instruction_path.resolve(strict=True)
            if source.is_relative_to(self.logs_dir.resolve()):
                raise ValueError("Frozen public input must stay outside model-writable logs")
            original = source.read_bytes().decode("utf-8")
            normalize = lambda text: text.replace("\r\n", "\n").replace("\r", "\n")
            if normalize(instruction) != normalize(original):
                raise ValueError("Harbor instruction transport changed public task content")
            instruction = original
        if hashlib.sha256(instruction.encode()).hexdigest() != self.options.rc_problem_statement_sha256:
            raise ValueError("Lite instruction differs from the frozen public problem statement")
        self._require_agent_network_boundary(environment)
        try:
            with environment.scoped_exec_env(self.business_exec_environment()):
                await super().run(instruction, environment, context)
        except BaseException as error:
            context.metadata = {**(context.metadata or {}), "swebenchLiteRuntimeFailure": {
                "type": type(error).__name__, "instanceId": self.options.rc_instance_id,
                "partialPredictionCollection": "Owner must confirm all model/tool writes stopped before collecting the existing workspace; never rerun inference to recover a patch."}}
            raise
        await self.collect_prediction(environment, context, partial=False, owner_confirmed_quiescence=True)

    async def collect_prediction(self, environment: BaseEnvironment, context: AgentContext, *,
                                 partial: bool, owner_confirmed_quiescence: bool) -> None:
        """Read-only post-inference artifact phase, with no model dispatch.

        Successful super().run proves host settlement. For a failed/partial run
        the root launcher must first stop all workspace writers (or collect a
        stopped-container copy with the standalone helper). This method does
        not turn a caller assertion into independent quiescence evidence.
        """
        if owner_confirmed_quiescence is not True:
            raise ValueError("Patch collection requires the owner's workspace freeze barrier")
        if getattr(self, "_lite_workspace_qualified", False) is not True:
            raise ValueError("Cannot collect an unqualified Lite workspace")
        with environment.scoped_exec_env(self.business_exec_environment()):
            result = await self._workspace_operation(environment, "collect", timeout_sec=120)
        patch_file = self.logs_dir / "candidate.diff"
        await environment.download_file(REMOTE + "/candidate.diff", patch_file)
        raw = patch_file.read_bytes()
        if (result.get("businessIndexUnchanged") is not True or result.get("automaticCommit") is not False
                or result.get("bytes") != len(raw) or result.get("sha256") != hashlib.sha256(raw).hexdigest()):
            raise ValueError("Actual collected patch identity or business-index boundary failed")
        prediction = {"instance_id": self.options.rc_instance_id, "model_name_or_path": self.model_name,
                      "model_patch": raw.decode("utf-8")}
        with (self.logs_dir / "prediction.jsonl").open("x") as destination:
            destination.write(json.dumps(prediction, ensure_ascii=False) + "\n")
        context.metadata = {**(context.metadata or {}), "swebenchLite": {
            "instanceId": self.options.rc_instance_id, "baseCommit": self.options.rc_base_commit,
            "problemStatementSha256": self.options.rc_problem_statement_sha256,
            "patchSha256": result["sha256"], "patchBytes": len(raw), "prediction": "prediction.jsonl",
            "partialRuntimeResult": partial, "artifactCollectionOnly": True,
            "ownerAssertedQuiescence": True, "officialGraderRunHere": False}}
