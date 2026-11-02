"""Real neutral Docker environment via pinned Harbor's public policy ports.

No sampled task, verifier, solution, model, or real provider key is read.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import shlex
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticket", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--client-timeout", type=int, default=2)
    parser.add_argument("--extra-compose", type=Path)
    args = parser.parse_args(); args.output.mkdir()
    assert 1 <= args.client_timeout <= 40
    from harbor.environments.docker.docker import DockerEnvironment
    from harbor.models.task.config import TaskConfig, EnvironmentConfig, NetworkMode
    from harbor.models.trial.config import AgentConfig, EnvironmentConfig as TrialEnvironmentConfig
    from harbor.models.trial.paths import TrialPaths
    from harbor.trial.network_policy import resolve_agent_env_baseline, resolve_agent_phase_policy
    ticket = json.loads(args.ticket.read_text())
    task = TaskConfig(environment={"docker_image": "python:3.11-slim", "cpus": 1, "memory_mb": 512, "network_mode": "no-network"},
                      agent={"network_mode": "no-network"})
    trial_agent = AgentConfig(name="scripts.bench.harbor_rc_gateway:RcGatewayOpenClaw", extra_allowed_hosts=["host.docker.internal"])
    baseline = resolve_agent_env_baseline(task, TrialEnvironmentConfig())
    agent_policy = resolve_agent_phase_policy(task, trial_agent, baseline)
    assert baseline.network_mode == NetworkMode.NO_NETWORK
    assert agent_policy.network_mode == NetworkMode.ALLOWLIST and agent_policy.allowed_hosts == ["host.docker.internal"]
    env_dir = args.output / "neutral-environment"; env_dir.mkdir()
    paths = TrialPaths(trial_dir=args.output / "trial"); paths.mkdir()
    environment = DockerEnvironment(environment_dir=env_dir, environment_name="rc-relay-neutral-probe",
        session_id="rc-probe-" + uuid.uuid4().hex[:12], trial_paths=paths, task_env_config=task.environment,
        network_policy=baseline, phase_network_policies=[agent_policy],
        extra_docker_compose=[args.extra_compose] if args.extra_compose else [])
    environment.validate_network_policy_support(baseline)
    environment.validate_network_policy_support(agent_policy)
    capabilities = environment.capabilities
    kernel_command = [*DockerEnvironment._engine_cmd("container", "run", "--rm",
        DockerEnvironment._EGRESS_CONTROL_KERNEL_PROBE_IMAGE, "sh", "-c", DockerEnvironment._EGRESS_CONTROL_KERNEL_PROBE_SCRIPT)]
    kernel = subprocess.run(kernel_command, capture_output=True, text=True, timeout=30)
    observations = []; result = {"state": "INCOMPLETE", "officialTaskStarted": False, "realModelRequests": 0,
        "baselinePolicy": baseline.model_dump(mode="json"), "agentPolicy": agent_policy.model_dump(mode="json"),
        "publicPolicyPort": "AgentConfig.extra_allowed_hosts + resolve_agent_phase_policy + BaseEnvironment.set_network_policy",
        "fixtureResources": {"cpus": 1, "memoryMb": 512}, "observations": observations}
    result["officialPolicyValidationPassed"] = True
    result["kernelProbe"] = {"returnCode": kernel.returncode, "stdout": kernel.stdout, "stderr": kernel.stderr,
                              "sameUnmodifiedFrameworkProbe": True}
    result["capabilities"] = {key: getattr(capabilities, key) for key in ("disable_internet", "network_allowlist", "dynamic_network_policy")}
    try:
        await environment.start(force_build=False)
        await environment.upload_file(args.ticket, "/tmp/rc-public-ticket.json")
        client = '''import json,urllib.request,socket
t=json.load(open('/tmp/rc-public-ticket.json'))
data=json.dumps({'model':'glm-5.3','messages':[{'role':'user','content':'Fictional relay reachability probe.'}],'max_tokens':16,'stream':False}).encode()
try:
 r=urllib.request.urlopen(urllib.request.Request(t['relayBaseUrl']+'/chat/completions',data=data,headers={'Authorization':'Bearer '+t['placeholderCredential'],'Content-Type':'application/json'}),timeout=CLIENT_TIMEOUT)
 print(json.dumps({'relayReachable':True,'status':r.status,'body':r.read().decode()}))
except Exception as e: print(json.dumps({'relayReachable':False,'errorType':type(e).__name__,'error':str(e)}))
try:
 s=socket.create_connection(('1.1.1.1',80),timeout=1);s.settimeout(1)
 s.sendall(b'GET / HTTP/1.1\\r\\nHost: 1.1.1.1\\r\\nConnection: close\\r\\n\\r\\n')
 data=s.recv(1024);s.close()
 print(json.dumps({'unlistedAddressReachable':bool(data),'applicationResponse':data.decode('utf-8',errors='replace')}))
except Exception as e: print(json.dumps({'unlistedAddressReachable':False,'errorType':type(e).__name__}))
'''
        client = client.replace('CLIENT_TIMEOUT', str(args.client_timeout))
        command = "python3 -c " + shlex.quote(client)
        async def observe(phase, require_block=True):
            reply = await environment.exec(command=command, timeout_sec=args.client_timeout + 10)
            assert reply.return_code == 0, reply.stderr
            records = [json.loads(line) for line in reply.stdout.splitlines() if line.startswith("{")]
            row = {"phase": phase, "records": records}; observations.append(row)
            (args.output / "checkpoint.json").write_text(json.dumps(result, indent=2) + "\n")
            if require_block: assert not records[1]["unlistedAddressReachable"], "Unlisted external address returned application data"
            return records[0]
        # This public phase belongs only to the disposable neutral calibration
        # fixture. No benchmark task policy or file is changed by this probe.
        from harbor.models.task.config import NetworkPolicy
        await environment.set_network_policy(NetworkPolicy(network_mode=NetworkMode.PUBLIC))
        positive = await observe("public-neutral-fixture-positive-control", require_block=False)
        assert positive["relayReachable"], "Public control could not reach the same relay"
        assert observations[-1]["records"][1]["unlistedAddressReachable"], "No positive application response from the negative-control target"
        await environment.set_network_policy(baseline)
        first = await observe("baseline-no-network")
        assert not first["relayReachable"], "Baseline no-network allowed the relay without an explicit phase exception"
        await environment.set_network_policy(agent_policy)
        allowed = await observe("official-extra-allowed-host")
        assert allowed["relayReachable"] and allowed["status"] == 200, "Explicit allowed model relay was unreachable"
        await environment.set_network_policy(baseline)
        last = await observe("restored-no-network")
        assert not last["relayReachable"], "Restoring the official no-network phase failed"
        result["state"] = "PINNED_HARBOR_DOCKER_PHASE_RELAY_QUALIFIED_NO_MODELS"
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        try:
            await environment.stop(delete=True)
            result["ownContainersRemoved"] = True
        except Exception as error:
            result["ownContainersRemoved"] = False
            result["cleanupError"] = {"type": type(error).__name__, "message": str(error)}
        (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"state": result["state"], "realModelRequests": 0}))
    if result["state"] == "INCOMPLETE": raise SystemExit(1)


if __name__ == "__main__": asyncio.run(main())
