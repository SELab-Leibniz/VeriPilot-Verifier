"""Reuse the Windows IO adaptation from offline-kitchen-collector.mjs.

The original verifier, assertions and offline audit hook stay unchanged.
Only child Python UTF-8 mode and parent decoding are made explicit.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

# The entry point is invoked with -B; this also protects programmatic imports.
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("bundled_verifier", sys.argv[1])
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
original_run = subprocess.run


def utf8_run(arguments, **kwargs):
    kwargs["encoding"] = "utf-8"
    return original_run([arguments[0], "-B", "-X", "utf8", *arguments[1:]], **kwargs)


verifier.subprocess.run = utf8_run
try:
    result = verifier.verify(Path(sys.argv[2]))
except Exception as error:
    print(json.dumps({"passed": False, "error": str(error)}, ensure_ascii=True))
    sys.exit(1)
print(json.dumps({"passed": True, "result": result}, ensure_ascii=True))
