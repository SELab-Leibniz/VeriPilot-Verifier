"""Prepare public transport tasks and root-launcher manifest templates only.

Reads the frozen public sample/identity/cache metadata. Does not read parquet,
gold/test patches, evaluator scripts, test-group lists, or existing outcomes.
No container, model, grader, image pull, or external source edit is performed.
"""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
import socket
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=SOURCE / "config/swe-bench-lite-pilot.json")
    parser.add_argument("--images", type=Path, default=SOURCE / ".runtime-correction/rc-supervision/swe-bench-lite-20261031/image-manifests-loaded-v1.json")
    parser.add_argument("--freeze", type=Path, default=SOURCE / ".runtime-correction/rc-supervision/swe-bench-lite-20261031/native-bridge-freeze-002.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    socket.socket.connect = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Public task preparation must not use network"))
    import toml
    from harbor.models.task.config import TaskConfig
    from harbor.models.task.task import Task
    from harbor.models.job.config import JobConfig
    from scripts.bench.swebench_lite_gateway import SweBenchLiteGatewayOpenClaw

    config = json.loads(args.config.read_text())
    samples_path = SOURCE / config["sampleManifest"]
    samples = json.loads(samples_path.read_text())
    assert samples["revision"] == config["datasetRevision"] and samples["sampleCount"] == 3
    images = json.loads(args.images.read_text()); assert images["allThreeLoadedVerified"] is True
    image_by_id = {row["instanceId"]: row for row in images["images"]}
    interface = json.loads((SOURCE / ".runtime-correction/rc-supervision/harbor-prototype-20261031/pilot-adapter-interface-v1.json").read_text())
    artifact = Path(interface["agentKwargs"]["rc_artifact_path"])
    artifact_pins = interface["artifactPins"]
    assert len(artifact_pins) == 245 and all(sha(Path(p)) == value for p, value in artifact_pins.items())
    freeze_path = args.freeze.resolve(strict=True)
    freeze = json.loads(freeze_path.read_text())
    assert all(sha(Path(p)) == value for p, value in freeze["sourceHashes"].items())
    args.output.mkdir()
    output = args.output.resolve()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    common_pins = {**freeze["sourceHashes"], **artifact_pins,
        str(samples_path): sha(samples_path), str(args.images.resolve()): sha(args.images),
        str(args.config.resolve()): sha(args.config), str(freeze_path): sha(freeze_path)}
    records = []
    all_volumes = set()
    selected = {row["instance_id"]: row for row in samples["selected"]}
    # Availability changes execution order only; all cases and one candidate
    # remain frozen before any score. Never pick a different sample.
    order = ["django__django-12708", "pytest-dev__pytest-7432", "sympy__sympy-12419"]
    assert set(order) == set(selected)
    for instance in order:
        row = selected[instance]; image = image_by_id[instance]
        assert image["officialRef"] == row["image"] and image["platform"] == "linux/amd64"
        case = output / instance; case.mkdir()
        task = case / "public-task"; task.mkdir(); (task / "environment").mkdir()
        instruction = task / "instruction.md"
        instruction.write_bytes(row["problem_statement"].encode("utf-8"))
        assert sha(instruction) == row["problemStatementSha256"]
        task_data = {"schema_version": "1.4", "metadata": {
                "benchmark": "SWE-bench Lite", "transport_only": True,
                "instance_id": instance, "dataset_revision": samples["revision"],
                "operator_inference_limit_sec": 1800, "readonly_artifact_allowance_sec": 120,
                "official_grading": "separate unchanged SWE-bench harness; no Harbor reward used"},
            "agent": {"timeout_sec": 1920, "network_mode": "allowlist", "allowed_hosts": ["host.docker.internal"]},
            "environment": {"docker_image": row["image"], "workdir": "/testbed", "cpus": 2,
                "memory_mb": 4096, "network_mode": "allowlist", "allowed_hosts": ["host.docker.internal"]}}
        task_config = task / "task.toml"; task_config.write_text(toml.dumps(task_data))
        dockerfile = task / "environment/Dockerfile"
        dockerfile.write_text("# Public prebuilt-image port; official image is neither rebuilt nor edited.\nFROM " + row["image"] + "\n")
        parsed = Task(task_dir=task, disable_verification=True)
        normalized = row["problem_statement"].replace("\r\n", "\n").replace("\r", "\n")
        assert parsed.instruction == normalized
        assert parsed.config.agent.timeout_sec == 1920
        assert parsed.config.environment.network_mode.value == "allowlist"
        assert parsed.config.environment.allowed_hosts == ["host.docker.internal"]
        slug = instance.split("__", 1)[1]
        clones_path = SOURCE / f".runtime-correction/rc-supervision/swe-bench-lite-20261031/runtime-cache-clones-{slug}-001/result.json"
        clones = json.loads(clones_path.read_text())
        assert clones["state"] == "EQUAL_PRISTINE_SEED_INDEPENDENT_ARM_CACHES_VERIFIED"
        assert clones["sharedWritableBusinessRuntimeCache"] is False
        volumes = {m["source"] for arm in ["off", "on"] for m in clones["arms"][arm]["mounts"]}
        assert len(volumes) == 4 and not all_volumes.intersection(volumes)
        all_volumes.update(volumes)
        for target in ["nvm", "npm"]:
            assert clones["arms"]["off"]["evidence"][target]["sha256"] == clones["arms"]["on"]["evidence"][target]["sha256"]
        overlay = case / "runtime-cache-volumes.compose.json"
        overlay.write_text(json.dumps({"volumes": {v: {"external": True} for v in sorted(volumes)}}, indent=2) + "\n")
        kwargs = {**interface["agentKwargs"], "rc_instance_id": instance,
            "rc_base_commit": row["base_commit"], "rc_problem_statement_sha256": row["problemStatementSha256"],
            "rc_original_instruction_path": str(instruction), "rc_conda_environment": "testbed",
            "rc_official_wall_ms": 1800000}
        # Actual installed options/factory construction; no setup/run called.
        SweBenchLiteGatewayOpenClaw(logs_dir=case / "schema-only-agent-logs", model_name="openai/glm-5.3",
            rc_relay_ticket=case / "unused-offline-ticket", rc_metering_receipt=case / "unused-receipt", **kwargs)
        mounts = [{"type": "bind", "source": str(artifact), "target": "/opt/rc-artifact", "read_only": True,
                "bind": {"create_host_path": False}},
            {"type": "bind", "source": str(SOURCE / "scripts/bench/swebench-lite-workspace.mjs"),
                "target": "/opt/rc-lite/swebench-lite-workspace.mjs", "read_only": True,
                "bind": {"create_host_path": False}}]
        pins = {**common_pins, str(clones_path): sha(clones_path), str(overlay): sha(overlay),
                str(instruction): sha(instruction), str(task_config): sha(task_config), str(dockerfile): sha(dockerfile)}
        manifest = {"kind": "rc-harbor-development-pilot-v1", "qualificationAccepted": False,
            "status": "PUBLIC_SCHEMA_VALIDATED_ROOT_ACTUAL_QUALIFICATION_AND_IMMUTABLE_COPY_REQUIRED",
            "createdUtc": now, "frameworkCommit": "58789aad577f432a4590209a8fd901f8c894f382",
            "model": "openai/glm-5.3", "sourceRoot": str(SOURCE),
            "harborExecutable": str(SOURCE / ".runtime-correction/rc-supervision/bench-runtime-20261031/harbor-pinned-env/bin/harbor"),
            "taskPath": str(task), "image": {"ref": row["image"], "id": image["localImageId"],
                "sourceRegistryIndexDigest": image["indexDigest"], "sourceRegistryPlatformDigest": image["platformDigest"]},
            "arms": ["off", "on"], "officialWallMs": 1800000, "armOuterWallMs": 3600000,
            "wallSemantics": "1800s operator inference/private/correction; public task wrapper1920s includes up to120s read-only patch collection. Neither is an official SWE-bench agent limit. Outer3600s is infrastructure fault guard.",
            "priorRequests": 254, "priorConservativeReferenceUsd": 19.973326,
            "actualAccountBill": "unknown", "limits": config["execution"]["allRoleModelLimitsPerArm"],
            "setupProxy": True, "agentImportPath": "scripts.bench.swebench_lite_gateway:SweBenchLiteGatewayOpenClaw",
            "agentKwargs": kwargs, "environment": {"delete": False, "kwargs": {"keep_containers": True},
                "mounts": mounts, "extra_docker_compose": [str(overlay)]},
            "armInstallCacheMounts": {arm: clones["arms"][arm]["mounts"] for arm in ["off", "on"]},
            "installCacheIsolation": {"evidence": str(clones_path), "equalStartingContents": True,
                "sharedWritableBusinessRuntimeCache": False, "writebackToSeed": False},
            "sourceHashes": pins, "qualificationEvidencePending": ["root actual selected-image native qualification", "root immutable execution copy and final ledger reconciliation"],
            "verifier": {"disable": True}, "officialScoring": "external unchanged SWE-bench harness only; no Harbor reward treated as official score",
            "partialRecovery": "Harbor stops but retains owned containers. Root copies /testbed from stopped container to a mode-preserving host temporary directory, uses frozen collector without model rerun, then removes exactly owned containers. Runtime error remains separate from official score.",
            "officialF2PP2PClaimed": False}
        # Validate the actual public Harbor job shape without task execution.
        job = JobConfig.model_validate({"job_name": "schema-lite-" + slug, "jobs_dir": str(case / "unused-jobs"),
            "n_attempts": 1, "n_concurrent_trials": 1, "retry": {"max_retries": 0}, "verifier": {"disable": True},
            "environment": {"type": "docker", "delete": True, **manifest["environment"],
                "mounts": mounts + manifest["armInstallCacheMounts"]["off"]},
            "agents": [{"import_path": manifest["agentImportPath"], "model_name": manifest["model"],
                "extra_allowed_hosts": ["host.docker.internal"], "kwargs": {**kwargs,
                    "rc_controller_descriptor": str(case / "unused-host-only-descriptor"),
                    "rc_metering_receipt": str(case / "unused-host-only-receipt")}}],
            "tasks": [{"path": str(task)}]})
        assert job.verifier.disable is True
        file = case / "manifest.template.json"; file.write_text(json.dumps(manifest, indent=2) + "\n")
        records.append({"instanceId": instance, "task": str(task), "manifestTemplate": str(file),
            "manifestSha256": sha(file), "rawInstructionSha256": sha(instruction),
            "harborNormalizedTransportSha256": hashlib.sha256(parsed.instruction.encode()).hexdigest(),
            "exactOriginalRestoredByNativeAdapter": True, "wrapperSeconds": 1920,
            "inferenceSeconds": 1800, "modelReady": False})
    report = {"state": "PUBLIC_HARBOR_TASKS_AND_MANIFEST_TEMPLATES_SCHEMA_VALIDATED",
        "createdUtc": now, "cases": records, "caseCount": 3, "independentBusinessVolumes": len(all_volumes),
        "sameFrozenCandidateFirstRound": True, "actualModelOrGraderRun": False,
        "privateDatasetColumnsRead": False, "noFakeHarborVerifierOrReward": True,
        "rootNext": "Verify actual qualifications, copy/rewrite all source/task/instruction/helper paths into immutable execution snapshot, reconcile prior ledger, then set qualificationAccepted only on that frozen manifest."}
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"state": report["state"], "caseCount": 3, "realModelRequests": 0}))


if __name__ == "__main__":
    main()
