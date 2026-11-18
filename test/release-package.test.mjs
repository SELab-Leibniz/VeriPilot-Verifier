import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { releaseMetadata } from '../scripts/build-release-package.mjs';

const archiveBytes = Buffer.from('package bytes');
const shasum = createHash('sha1').update(archiveBytes).digest('hex');
const pack = [{ name: 'runtime-corrector-openclaw', version: '1.10.0', filename: 'runtime-corrector-openclaw-1.10.0.tgz', shasum, integrity: 'sha512-x', entryCount: 253 }];
const input = { pack, archiveBytes, archive: path.join('out', pack[0].filename), sourceCommit: '50201d2f95ba1953c9c3039827d07fd19073940a',
  packageJson: { name: 'runtime-corrector-openclaw', version: '1.10.0' }, pluginManifest: { version: '1.10.0' } };

test('release metadata binds the archive digest, source commit and version from npm pack', () => {
  assert.deepEqual(releaseMetadata(input), { version: '1.10.0', sourceCommit: input.sourceCommit,
    packageSha256: createHash('sha256').update(archiveBytes).digest('hex'), archive: input.archive,
    npm: { name: 'runtime-corrector-openclaw', filename: pack[0].filename, shasum, integrity: 'sha512-x', entryCount: 253 } });
});

test('release metadata rejects abbreviated commits, changed bytes and version drift', () => {
  assert.throws(() => releaseMetadata({ ...input, sourceCommit: '50201d2' }), /full commit/u);
  assert.throws(() => releaseMetadata({ ...input, archiveBytes: Buffer.from('other') }), /differ from npm pack/u);
  assert.throws(() => releaseMetadata({ ...input, pluginManifest: { version: '1.9.0' } }), /versions differ/u);
  assert.throws(() => releaseMetadata({ ...input, packageJson: { ...input.packageJson, version: '1.9.0' } }));
  assert.throws(() => releaseMetadata({ ...input, pack: [...pack, pack[0]] }), /exactly one/u);
  assert.throws(() => releaseMetadata({ ...input, archive: path.join('out', 'other.tgz') }));
});
