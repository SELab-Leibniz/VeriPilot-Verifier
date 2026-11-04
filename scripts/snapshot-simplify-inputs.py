"""Fingerprint read-only experiment inputs without opening reparse targets."""

import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def snapshot(root):
    if os.name == "nt":
        root = "\\\\?\\" + str(Path(root).resolve(strict=True))
    files = []
    reparse_points = []
    pending = [(root, "")]
    while pending:
        directory, prefix = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                relative = prefix + entry.name
                metadata = entry.stat(follow_symlinks=False)
                if getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT or entry.is_symlink():
                    reparse_points.append(relative)
                elif entry.is_dir(follow_symlinks=False):
                    pending.append((entry.path, relative + "/"))
                elif entry.is_file(follow_symlinks=False):
                    with open(entry.path, "rb") as handle:
                        digest = hashlib.file_digest(handle, "sha256").hexdigest()
                    files.append((relative, digest))
    manifest = json.dumps([sorted(files), sorted(reparse_points)], ensure_ascii=True, separators=(",", ":"))
    return {
        "files": len(files),
        "reparsePoints": len(reparse_points),
        "sha256": hashlib.sha256(manifest.encode("ascii")).hexdigest(),
    }


output, matrix, openclaw, dataset = sys.argv[1:]
roots = {"MatrixAssistant": matrix, "OpenClaw": openclaw, "dataset": dataset}
with open(output, "x", encoding="utf-8") as handle:
    json.dump({name: snapshot(root) for name, root in roots.items()}, handle, indent=2)
    handle.write("\n")
