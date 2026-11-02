"""Score actual pre/post-Stop commits with the original separate verifier."""
import argparse
import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepared-root', type=Path, required=True)
    parser.add_argument('--attempt', default='live-relay-001')
    parser.add_argument('--verifier-image', default='rc-stop-gql-official-verifier:427384f-amd64')
    args = parser.parse_args()
    root = args.prepared_root.resolve(strict=True)
    live = root / args.attempt
    manifest = json.loads((root / 'manifest.json').read_text())
    assert manifest['task'] == 'gql-incremental-graphql-delivery'
    assert json.loads((live / 'process-exit.json').read_text())['relayClosed'] is True
    image_id = subprocess.check_output(['docker', 'image', 'inspect', '--platform', 'linux/amd64', args.verifier_image,
                                        '--format', '{{.Id}}'], text=True).strip()
    scoring = live / 'official-scoring'
    scoring.mkdir()
    rows = []
    for label, source in [('before', live / 'first-stop/model.patch'), ('after', live / 'model.patch')]:
        if not source.exists():
            rows.append({'phase': label, 'state': 'NO_PATCH_SNAPSHOT', 'score': None})
            continue
        destination = scoring / label
        artifacts = destination / 'logs/artifacts'
        artifacts.mkdir(parents=True)
        patch = artifacts / 'model.patch'
        shutil.copy2(source, patch)
        original_hash = sha(source)
        name = 'rc-stop-gql-score-' + label + '-' + str(int(time.time()))
        command = ['docker', 'run', '--platform', 'linux/amd64', '--name', name,
                   '--network', 'none', '--cpus', '2', '--memory', '8g',
                   '--mount', f'type=bind,source={destination}/logs,target=/logs',
                   '--entrypoint', '/bin/bash', image_id, '/tests/test.sh']
        record = {'phase': label, 'patchSha256': original_hash, 'patchBytes': patch.stat().st_size,
                  'verifierImageId': image_id, 'command': command,
                  'timeoutSec': 1800, 'startedAt': time.time(), 'officialVerifierModified': False,
                  'modelRequests': 0}
        (destination / 'launch.json').write_text(json.dumps(record, indent=2))
        print(json.dumps({'state': 'OFFICIAL_SCORER_STARTED', 'phase': label}), flush=True)
        with (destination / 'official-console.log').open('x') as log:
            try:
                execution = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
                record['exitCode'] = execution.returncode
            except subprocess.TimeoutExpired:
                subprocess.run(['docker', 'stop', '-t', '10', name], stdout=log, stderr=subprocess.STDOUT, timeout=30)
                record['exitCode'] = None
                record['timeout'] = True
        assert sha(source) == original_hash
        reward_file = destination / 'logs/verifier/reward.json'
        record['reward'] = json.loads(reward_file.read_text()) if reward_file.exists() else None
        record['state'] = 'OFFICIAL_REWARD_AVAILABLE' if record['reward'] is not None else 'OFFICIAL_REWARD_MISSING'
        record['elapsedSec'] = time.time() - record['startedAt']
        (destination / 'result.json').write_text(json.dumps(record, indent=2))
        rows.append(record)
        print(json.dumps({'phase': label, 'state': record['state'], 'exitCode': record['exitCode'],
                          'reward': record['reward'], 'elapsedSec': record['elapsedSec']}), flush=True)
    result = {'benchmark': manifest['benchmark'], 'task': manifest['task'], 'attempt': args.attempt,
              'stopRun': str(live / 'result.json'), 'rows': rows,
              'comparison': 'Same trajectory: first completed commits versus final commits; not an RC-off comparison'}
    (scoring / 'comparison.json').write_text(json.dumps(result, indent=2))
    return 0 if len(rows) == 2 and all(r['state'] == 'OFFICIAL_REWARD_AVAILABLE' for r in rows) else 1


if __name__ == '__main__':
    raise SystemExit(main())
