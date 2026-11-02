"""Run the unchanged pinned official grader; expose only aggregate test counts.

This trusted post-inference process is never mounted into the agent container.
Raw official reports and logs are retained without editing or printing test names.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def project_report(report, instance):
    row = report[instance]
    projected = {key: row.get(key) for key in (
        'resolved', 'patch_is_None', 'patch_exists', 'patch_successfully_applied', 'infra_failure')}
    projected['testBuckets'] = {}
    for key in ('FAIL_TO_PASS', 'PASS_TO_PASS'):
        bucket = row.get('tests_status', {}).get(key)
        if not isinstance(bucket, dict) or not all(isinstance(bucket.get(k), list) for k in ('success', 'failure')):
            projected['testBuckets'][key] = {'status': 'unavailable', 'rate': None}
            continue
        passed, failed = len(bucket['success']), len(bucket['failure'])
        denominator = passed + failed
        projected['testBuckets'][key] = {
            'status': 'scored' if denominator else 'empty_not_applicable',
            'success': passed, 'failure': failed, 'denominator': denominator,
            'rate': passed / denominator if denominator else None}
    projected['testNamesExposed'] = False
    return projected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--python', type=Path, required=True)
    parser.add_argument('--harness-source', type=Path, required=True)
    parser.add_argument('--harness-commit', required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--dataset-sha256', required=True)
    parser.add_argument('--prediction', type=Path, required=True)
    parser.add_argument('--instance-id', required=True)
    parser.add_argument('--image-ref', required=True)
    parser.add_argument('--expected-image-id', required=True)
    parser.add_argument('--arm', choices=['off', 'on'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert re.fullmatch(r'[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-[0-9]+', args.instance_id)
    assert args.harness_commit == '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e'
    assert re.fullmatch(r'sha256:[a-f0-9]{64}', args.expected_image_id)
    source, dataset, prediction = [p.resolve(strict=True) for p in (
        args.harness_source, args.dataset, args.prediction)]
    # Preserve the venv executable path: resolving its symlink loses pyvenv.cfg.
    python = args.python.absolute()
    assert python.is_file()
    run = lambda argv: subprocess.check_output(argv, text=True, timeout=30).strip()
    def check_pins():
        assert run(['git', '-C', str(source), 'rev-parse', 'HEAD']) == args.harness_commit
        assert not run(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no'])
        assert sha(dataset) == args.dataset_sha256
        assert run(['docker', 'image', 'inspect', args.image_ref, '--format', '{{.Id}}']) == args.expected_image_id
    check_pins()
    prediction_hash = sha(prediction)
    rows = [json.loads(line) for line in prediction.read_text().splitlines() if line.strip()]
    assert len(rows) == 1
    row, = rows
    assert row['instance_id'] == args.instance_id and row['model_name_or_path'] == 'openai/glm-5.3'
    assert isinstance(row['model_patch'], str)
    output = args.output.resolve()
    output.mkdir(parents=True)
    os.chmod(output, 0o700)
    run_id = 'rc-lite-' + args.arm + '-' + uuid.uuid4().hex
    command = [str(python), '-m', 'swebench.harness.run_evaluation',
        '--dataset_name', str(dataset), '--split', 'test', '--instance_ids', args.instance_id,
        '--predictions_path', str(prediction), '--max_workers', '1', '--timeout', '1800', '--run_id', run_id]
    env = {k: v for k, v in os.environ.items() if not re.search(
        r'API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL', k, re.I)}
    env.update(PYTHONPATH=str(source), PYTHONDONTWRITEBYTECODE='1')
    result = {'kind': 'rc-lite-official-grader-v1', 'arm': args.arm, 'instanceId': args.instance_id,
        'runId': run_id, 'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'predictionSha256': prediction_hash, 'harnessCommit': args.harness_commit,
        'datasetSha256': args.dataset_sha256, 'officialGraderModified': False, 'realModelRequests': 0,
        'timeoutSec': 1800, 'command': command}
    (output / 'launch.json').write_text(json.dumps(result, indent=2) + '\n')
    with (output / 'official-grader.log').open('x') as log:
        try:
            execution = subprocess.run(command, cwd=output, env=env, stdout=log, stderr=log, timeout=2400)
            result['exitCode'] = execution.returncode
        except subprocess.TimeoutExpired:
            result['exitCode'] = None
            result['outerTimeout'] = True
    check_pins()
    assert sha(prediction) == prediction_hash
    report = output / 'logs/evaluation' / run_id / 'openai__glm-5.3' / args.instance_id / 'report.json'
    result['officialReport'] = str(report)
    if report.is_file():
        result['officialReportSha256'] = sha(report)
        result['score'] = project_report(json.loads(report.read_text()), args.instance_id)
        result['state'] = 'OFFICIAL_REPORT_AVAILABLE'
    else:
        result['score'] = None
        result['state'] = 'OFFICIAL_REPORT_UNAVAILABLE'
    result['finishedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: result[k] for k in ('state', 'arm', 'instanceId', 'score', 'exitCode')}))
    return 0 if result['state'] == 'OFFICIAL_REPORT_AVAILABLE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
