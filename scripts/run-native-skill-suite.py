"""Run the frozen Stop-only cases and then their separate original verifiers."""
import argparse
import getpass
import json
import os
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepared-root', type=Path, required=True)
    parser.add_argument('--attempt', default='live-001')
    parser.add_argument('--parallel', type=int, default=1)
    args = parser.parse_args()
    assert 1 <= args.parallel <= 3
    root = args.prepared_root.resolve(strict=True)
    source = root / 'runner-source'
    key = os.environ.pop('RC_EVAL_API_KEY', None) or getpass.getpass('GLM key (not saved): ')
    env = dict(os.environ, RC_EVAL_API_KEY=key)
    queue = [row['task'] for row in json.loads((root / 'suite.json').read_text())]
    active, rows = {}, []
    while queue or active:
        while queue and len(active) < args.parallel:
            task = queue.pop(0)
            log = (root / task / (args.attempt + '-controller.log')).open('x')
            cmd = ['node', str(source / 'scripts/run-native-skill-benchmark.mjs'),
                   '--prepared-root', str(root / task), '--attempt', args.attempt]
            process = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
            active[task] = (process, log, time.time())
            print(json.dumps(dict(task=task, state='STARTED', pid=process.pid)), flush=True)
        for task, (process, log, started) in list(active.items()):
            if process.poll() is None:
                continue
            log.close()
            row = dict(task=task, exitCode=process.returncode, elapsedSec=time.time()-started)
            # No account credentials are needed by the isolated scorer.
            with (root / task / (args.attempt + '-grading.log')).open('x') as grade_log:
                result = subprocess.run(['python3', str(source / 'scripts/grade-native-skill-benchmark.py'),
                    '--prepared-root', str(root / task), '--attempt', args.attempt],
                    stdout=grade_log, stderr=subprocess.STDOUT)
            row['graderExitCode'] = result.returncode
            rows.append(row)
            (root / (args.attempt + '-suite-result.json')).write_text(json.dumps(rows, indent=2) + '\n')
            print(json.dumps(row), flush=True)
            del active[task]
        time.sleep(2)
    return 0 if all(row['exitCode'] == row['graderExitCode'] == 0 for row in rows) else 1


if __name__ == '__main__':
    raise SystemExit(main())
