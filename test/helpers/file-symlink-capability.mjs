import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let capability;
export function fileSymlinkSkipReason() {
  if (process.platform !== 'win32') return undefined;
  return capability ??= (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-file-symlink-probe-'));
    try {
      const file = path.join(root, 'original.txt'); await fs.writeFile(file, 'Controlled link capability probe.');
      await fs.symlink(file, path.join(root, 'linked.txt'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code))
        return 'Windows file symlinks unavailable for this process; directory junction boundary tests run separately.';
      throw error;
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  })();
}
