"""Exercise the real kitchen CLI with networking denied in each app process."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


BOOTSTRAP = r'''
import runpy, sys
def offline(event, args):
    if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.exec"}:
        print("OFFLINE_FORBIDDEN:" + event, file=sys.stderr)
        raise PermissionError("offline kitchen validation forbids network and child processes")
sys.addaudithook(offline)
app, *arguments = sys.argv[1:]
sys.argv = [app, *arguments]
runpy.run_path(app, run_name="__main__")
'''


def verify(project):
    project = Path(project).resolve()
    app = project / "kitchen.py"
    report = {"status": "RUNNING", "networkPolicy": "DENIED", "cases": []}
    if not app.is_file():
        raise ValueError("kitchen.py is missing")
    report["codeHash"] = hashlib.sha256(app.read_bytes()).hexdigest()
    env = {k: v for k, v in os.environ.items()
           if not any(word in k.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD"))}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    with tempfile.TemporaryDirectory(prefix=".kitchen-check-", dir=project) as directory:
        store = Path(directory) / "kitchen.json"
        other = Path(directory) / "other.json"

        def call(label, arguments, expected=None, invalid=False, unchanged=False, target=store):
            before = target.read_bytes() if target.exists() else None
            result = subprocess.run(
                [sys.executable, "-I", "-S", "-c", BOOTSTRAP, str(app), *arguments],
                cwd=project, env=env, capture_output=True, text=True, timeout=10,
            )
            row = {"case": label, "args": arguments, "exit": result.returncode,
                   "stdout": result.stdout, "stderr": result.stderr}
            report["cases"].append(row)
            if "OFFLINE_FORBIDDEN:" in result.stdout + result.stderr:
                raise ValueError(f"{label}: app attempted network or child-process access")
            if invalid:
                if result.returncode == 0 or not result.stderr.strip():
                    raise ValueError(f"{label}: expected nonzero exit and explanatory stderr")
            else:
                if result.returncode != 0 or result.stderr:
                    raise ValueError(f"{label}: unexpected exit/stderr: {row}")
                if expected is not None and json.dumps(json.loads(result.stdout), sort_keys=True) != json.dumps(expected, sort_keys=True):
                    raise ValueError(f"{label}: unexpected JSON result: {row}")
            if unchanged:
                after = target.read_bytes() if target.exists() else None
                if before != after:
                    raise ValueError(f"{label}: store bytes changed")
                row["storeBytesUnchanged"] = True
            return result

        def run(label, arguments, **kwargs):
            return call(label, ["--store", str(store), *arguments], **kwargs)

        help_result = call("help", ["--help"])
        if "usage" not in help_result.stdout.lower():
            raise ValueError("--help must show usage")
        run("empty-pantry", ["pantry", "list"], expected={}, unchanged=True)
        run("empty-recipes", ["recipe", "list"], expected={}, unchanged=True)
        recipe = "番茄炒蛋 🍳"
        ingredients = {"番茄": 2, "鸡蛋": 3}
        run("unicode-recipe", ["recipe", "add", recipe, json.dumps(ingredients, ensure_ascii=False)],
            expected={"name": recipe, "ingredients": ingredients})
        run("persisted-recipe", ["recipe", "list"], expected={recipe: ingredients}, unchanged=True)
        run("set-tomato", ["pantry", "set", "番茄", "2"], expected={"name": "番茄", "amount": 2})
        run("set-insufficient-eggs", ["pantry", "set", "鸡蛋", "2"], expected={"name": "鸡蛋", "amount": 2})
        run("shortfall", ["can-cook", recipe], expected={"can_cook": False, "missing": {"鸡蛋": 1}}, unchanged=True)
        run("failed-cook-atomic", ["cook", recipe], invalid=True, unchanged=True)
        run("no-partial-consumption", ["pantry", "list"], expected={"番茄": 2, "鸡蛋": 2}, unchanged=True)
        run("restock", ["pantry", "set", "鸡蛋", "3"], expected={"name": "鸡蛋", "amount": 3})
        run("ready-to-cook", ["can-cook", recipe], expected={"can_cook": True, "missing": {}}, unchanged=True)
        run("cook", ["cook", recipe], expected={"cooked": recipe})
        run("persisted-consumption", ["pantry", "list"], expected={"番茄": 0, "鸡蛋": 0}, unchanged=True)
        run("unknown-recipe", ["cook", "不存在的菜"], invalid=True, unchanged=True)
        run("negative-stock", ["pantry", "set", "番茄", "-1"], invalid=True, unchanged=True)
        run("malformed-recipe", ["recipe", "add", "坏菜", "{"], invalid=True, unchanged=True)
        run("zero-ingredient", ["recipe", "add", "坏菜", '{"盐":0}'], invalid=True, unchanged=True)
        run("boolean-ingredient", ["recipe", "add", "坏菜", '{"盐":true}'], invalid=True, unchanged=True)
        original = store.read_bytes()
        call("other-store-pantry", ["--store", str(other), "pantry", "list"], expected={}, target=other, unchanged=True)
        call("other-store-recipes", ["--store", str(other), "recipe", "list"], expected={}, target=other, unchanged=True)
        if store.read_bytes() != original:
            raise ValueError("isolated store commands modified the original store")
    report.update(status="PASS", scenarios=len(report["cases"]))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    args = parser.parse_args()
    if not args.project.is_absolute():
        parser.error("--project must be absolute")
    try:
        report = verify(args.project)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"KITCHEN_INVALID: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False))
    print("KITCHEN_VERIFIED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
