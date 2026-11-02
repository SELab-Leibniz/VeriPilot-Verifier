"""Clone an idle, model-free installer seed for isolated benchmark arms.

Only RC-owned Docker volumes are touched. Task images, installers and graders
are unchanged; no network or account credential enters the copy containers.
"""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--seed-manifest', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir()
seed = json.loads(args.seed_manifest.read_text())
run = lambda argv: subprocess.check_output(argv, text=True, timeout=180).strip()
for source in seed['volumes'].values():
    metadata = json.loads(run(['docker', 'volume', 'inspect', source]))[0]
    assert metadata['Labels']['runtime-corrector.purpose'] == 'isolated-benchmark-install-cache'
    assert not run(['docker', 'ps', '--filter', 'volume=' + source, '--format', '{{.ID}}']), 'Installer seed is still mounted by a running container'
copy_image = run(['docker', 'image', 'inspect', 'python:3.11-slim', '--format', '{{.Id}}'])

copy_program = r'''
import hashlib,json,os,pathlib,shutil,stat
def inventory(root):
 h=hashlib.sha256();count=0
 for p in sorted(pathlib.Path(root).rglob('*')):
  s=p.lstat();kind=stat.S_IFMT(s.st_mode)
  if stat.S_ISLNK(s.st_mode):content=os.readlink(p)
  elif stat.S_ISREG(s.st_mode):
   fhash=hashlib.sha256()
   with p.open('rb') as f:
    for chunk in iter(lambda:f.read(1048576),b''):fhash.update(chunk)
   content=fhash.hexdigest()
  elif stat.S_ISDIR(s.st_mode):content=None
  else:raise RuntimeError('Unexpected installer cache entry type')
  h.update(json.dumps([str(p.relative_to(root)),kind,stat.S_IMODE(s.st_mode),s.st_size if not stat.S_ISDIR(s.st_mode) else None,content],separators=(',',':')).encode());count+=1
 return {'sha256':h.hexdigest(),'entries':count}
before=inventory('/seed')
assert before['entries']>0,'Installer seed is empty'
assert not list(pathlib.Path('/clone').iterdir()),'Runtime clone was not empty'
shutil.copytree('/seed','/clone',dirs_exist_ok=True,symlinks=True)
after=inventory('/seed');cloned=inventory('/clone')
assert before==after==cloned,(before,after,cloned)
print(json.dumps(before))
'''
result = {'kind': 'pristine_install_seed_independent_runtime_clones', 'state': 'INCOMPLETE',
          'createdUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'arms': {},
          'sourceManifest': str(args.seed_manifest.resolve()), 'realModelRequests': 0,
          'sharedWritableBusinessRuntimeCache': False, 'copyNetwork': 'none', 'copyImageId': copy_image}
try:
    suffix = uuid.uuid4().hex[:10]
    for arm in ('off', 'on'):
        mounts = []; evidence = {}
        result['arms'][arm] = {'mounts': mounts, 'evidence': evidence}
        for kind, source in seed['volumes'].items():
            target = 'rc-harbor-runtime-' + suffix + '-' + arm + '-' + kind
            run(['docker', 'volume', 'create', '--label', 'runtime-corrector.purpose=isolated-benchmark-runtime-cache', target])
            mounts.append({'type': 'volume', 'source': target, 'target': '/root/.' + kind})
            raw = run(['docker', 'run', '--rm', '--network', 'none', '-v', source + ':/seed:ro', '-v', target + ':/clone',
                       copy_image, 'python3', '-c', copy_program])
            evidence[kind] = {'seed': source, 'runtime': target, **json.loads(raw)}
    for kind in seed['volumes']:
        assert result['arms']['off']['evidence'][kind]['sha256'] == result['arms']['on']['evidence'][kind]['sha256']
    result['state'] = 'EQUAL_PRISTINE_SEED_INDEPENDENT_ARM_CACHES_VERIFIED'
finally:
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'state': result['state'], 'realModelRequests': 0}))
