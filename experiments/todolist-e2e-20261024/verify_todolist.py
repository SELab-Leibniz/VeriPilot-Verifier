"""Independent frozen acceptance; never writes business source files."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def verify(project):
    app = project / "todo.py"
    digest = hashlib.sha256(app.read_bytes()).hexdigest()
    unit = subprocess.run(
        [sys.executable, "-m", "unittest", "-v", "test_todo.py"],
        cwd=project, capture_output=True, text=True, encoding="utf-8", timeout=90,
    )
    report = {"codeHash": digest, "unitTests": 9, "journeys": 1, "scenarios": 10,
              "unit": {"exitCode": unit.returncode, "stdout": unit.stdout, "stderr": unit.stderr},
              "journey": []}
    if unit.returncode != 0 or "Ran 9 tests" not in unit.stderr or "\nOK" not in unit.stderr:
        return {**report, "status": "FAIL", "reason": "Frozen unit acceptance failed"}
    with tempfile.TemporaryDirectory(prefix="todolist-journey-") as directory:
        store = Path(directory) / "data" / "todos.json"

        def cli(*args):
            result = subprocess.run(
                [sys.executable, str(app), "--store", str(store), *args],
                cwd=project, capture_output=True, text=True, encoding="utf-8", timeout=10,
            )
            step = {"args": list(args), "exitCode": result.returncode,
                    "stdout": result.stdout, "stderr": result.stderr}
            report["journey"].append(step)
            if result.returncode != 0:
                raise AssertionError(f"Command failed: {step}")
            return json.loads(result.stdout)

        try:
            added = cli("add", "买鲜花 🌻")
            assert added == {"id": 1, "title": "买鲜花 🌻", "completed": False}
            assert cli("list") == [added]
            assert cli("rename", "1", "浇花") == {"id": 1, "title": "浇花", "completed": False}
            assert cli("complete", "1")["completed"] is True
            assert cli("list")[0]["completed"] is True
            assert cli("reopen", "1")["completed"] is False
            assert cli("list")[0]["completed"] is False
            cli("delete", "1")
            assert cli("list") == []
            assert hashlib.sha256(app.read_bytes()).hexdigest() == digest
        except (AssertionError, ValueError, KeyError) as error:
            return {**report, "status": "FAIL", "reason": str(error)}
    return {**report, "status": "PASS"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.project.resolve())
    except Exception as error:
        result = {"status": "FAIL", "reason": f"{type(error).__name__}: {error}"}
    print(json.dumps(result, ensure_ascii=False))
    if result["status"] == "PASS":
        print("TODOLIST_VERIFIED")
    sys.exit(0 if result["status"] == "PASS" else 1)
