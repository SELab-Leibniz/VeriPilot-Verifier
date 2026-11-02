"""Freeze public DeepSWE inputs and build separate, unchanged verifier images.

Requires Python 3.11+. Never copies solutions or verifier files into agent mounts.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import tomllib
from pathlib import Path


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--timeout-ms', type=int, default=86400000)
    parser.add_argument('--max-steps', type=int, default=2000)
    parser.add_argument('tasks', nargs='+')
    args = parser.parse_args()
    assert 2000 <= args.timeout_ms <= 86400000 and args.timeout_ms % 1000 == 0
    assert 1 <= args.max_steps <= 9007199254740991
    source = Path(__file__).resolve().parents[1]
    dataset = args.dataset.resolve(strict=True)
    dataset_commit = command('git', '-C', str(dataset), 'rev-parse', 'HEAD')
    assert dataset_commit == '427384f43d8001f2b14a82e99ace940cc234045a'
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    frozen = root / 'runner-source'
    frozen.mkdir()
    names = command('git', '-C', str(source), 'ls-files').splitlines()
    names += ['scripts/' + name for name in [
        'evaluate-native-skill-benchmark.mjs', 'run-native-skill-benchmark.mjs',
        'grade-native-skill-benchmark.py', 'prepare-native-skill-benchmarks.py',
        'run-native-skill-suite.py']]
    hashes = {}
    for name in sorted(set(names)):
        # Runtime code is sufficient inside the agent container. Keep prior
        # reports, fixtures and example solutions out of future case mounts.
        if Path(name).parts[0] in {'docs', 'test', 'examples'}:
            continue
        item = source / name
        if not item.is_file():
            continue
        dest = frozen / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, dest)
        hashes[name] = sha(dest)
    (root / 'source-identity.json').write_text(json.dumps(hashes, indent=2) + '\n')
    artifact = root / 'artifact'
    shutil.copytree(source / 'dist/runtime-corrector-openclaw', artifact)
    rows = []
    for task in args.tasks:
        assert task.replace('-', '').isalnum() and task.isascii()
        original = dataset / 'tasks' / task
        # Public files must still match the pinned dataset revision.
        for name in ['instruction.md', 'task.toml', 'tests/Dockerfile']:
            assert subprocess.check_output(['git', '-C', str(dataset), 'show',
                f'{dataset_commit}:tasks/{task}/{name}']) == (original / name).read_bytes()
        meta = tomllib.loads((original / 'task.toml').read_text())
        case = root / task
        (case / 'public').mkdir(parents=True)
        shutil.copy2(original / 'instruction.md', case / 'public/instruction.md')
        skill = case / 'skill/skills/bench-task-contract'
        skill.mkdir(parents=True)
        skill_text = '---\nname: bench-task-contract\ndescription: Follow this original public software task contract.\n---\n\n' + (original / 'instruction.md').read_text()
        (skill / 'SKILL.md').write_text(skill_text)
        policy = subprocess.check_output(['node', '--input-type=module', '-e',
            "import {skillBenchmarkPolicy} from './scripts/helpers/skill-benchmark-budgets.mjs'; process.stdout.write(skillBenchmarkPolicy({wallMs:Number(process.argv[1]),maxSteps:Number(process.argv[2])}));",
            str(args.timeout_ms), str(args.max_steps)], cwd=source, text=True)
        (case / 'public/config.yaml').write_text(policy)

        (case / 'artifact').symlink_to(artifact, target_is_directory=True)
        (case / 'runner-source').symlink_to(frozen, target_is_directory=True)
        image = meta['environment']['docker_image']
        image_id = command('docker', 'image', 'inspect', image, '--format', '{{.Id}}')
        verifier = 'rc-skill-real-' + task + ':427384f'
        # Original verifier Dockerfile; opaque tests stay in a separate build.
        context = root / 'verifier-builds' / task
        shutil.copytree(original / 'tests', context)
        verifier_hashes = {}
        for item in sorted(context.rglob('*')):
            if item.is_file():
                name = item.relative_to(context).as_posix()
                assert subprocess.check_output(['git', '-C', str(dataset), 'show',
                    f'{dataset_commit}:tasks/{task}/tests/{name}']) == item.read_bytes()
                verifier_hashes[name] = sha(item)
        subprocess.run(['docker', 'build', '--platform', 'linux/amd64',
                        '-t', verifier, str(context)], check=True)
        manifest = dict(benchmark='DeepSWE 1.1', task=task, datasetCommit=dataset_commit,
            baseCommit=meta['metadata']['base_commit_hash'], image=image, imageId=image_id,
            verifierImage=verifier,
            verifierImageId=command('docker', 'image', 'inspect', verifier, '--format', '{{.Id}}'),
            verifierFileHashes=verifier_hashes,
            instructionSha256=sha(case / 'public/instruction.md'),
            sourceCommit=command('git', '-C', str(source), 'rev-parse', 'HEAD'),
            model='glm-5.3-flash', reasoningEffort='low', maxRuntimeMs=args.timeout_ms,
            formatRepairAttempts=args.max_steps, maxSteps=args.max_steps, verifierTimeoutSec=args.timeout_ms // 1000,
            correctionLimit=args.max_steps, hiddenVerifierMountedInAgent=False, injectedDefect=False,
            modules=dict(skill=True, terminalTransport='Existing Skill M08 only', globalBaseline=False, document=False, writeTimeImplementation=False),
            skipHostWorkspaceBootstrap=True, officialVerifierModified=False,
            resources=dict(cpus=2, memory='8g', platform='linux/amd64'),
            skillSource='Original public benchmark instruction copied verbatim below Skill frontmatter', skillSha256=sha(skill / 'SKILL.md'), policySha256=sha(case / 'public/config.yaml'), agentNetwork='Provider relay on bridge; Skill-adoption wrapper, not official protocol equivalence',
            officialVerifierNetwork='none',
            beforeAfter='Same trajectory first completed commits vs final commits; not RC-off')
        (case / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        rows.append(manifest)
    (root / 'suite.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(json.dumps(dict(prepared=str(root), tasks=[r['task'] for r in rows])))


if __name__ == '__main__':
    main()
