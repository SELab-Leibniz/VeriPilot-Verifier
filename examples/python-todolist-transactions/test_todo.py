"""Each assertion uses a fresh Python CLI process against real JSON files."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

APP = Path(__file__).with_name("todo.py")


class TodoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Path(self.directory.name) / "data/todos.json"

    def command(self, *args, operation=None, expected=0):
        command = [sys.executable, str(APP), "--store", str(self.store)]
        if operation:
            command += ["--operation-id", operation]
        result = subprocess.run(command + list(args), capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stderr)
        return json.loads(result.stdout) if expected == 0 else result.stderr

    def test_empty_list_does_not_write(self):
        self.assertEqual(self.command("list"), [])
        self.assertFalse(self.store.exists())

    def test_add_unicode_and_persist_across_processes(self):
        item = self.command("add", "买牛奶 🥛", operation="add-one")
        self.assertEqual(item, {"id": 1, "title": "买牛奶 🥛", "completed": False})
        self.assertEqual(self.command("list"), [item])

    def test_rename(self):
        self.command("add", "first")
        self.assertEqual(self.command("rename", "1", "changed")["title"], "changed")
        self.assertEqual(self.command("list")[0]["title"], "changed")

    def test_complete_and_reopen(self):
        self.command("add", "first")
        self.assertTrue(self.command("complete", "1")["completed"])
        self.assertTrue(self.command("list")[0]["completed"])
        self.assertFalse(self.command("reopen", "1")["completed"])

    def test_delete_does_not_reuse_ids(self):
        self.command("add", "first")
        self.command("delete", "1")
        self.assertEqual(self.command("list"), [])
        self.assertEqual(self.command("add", "second")["id"], 2)

    def test_empty_title_rejected_without_mutation(self):
        self.command("add", "valid")
        before = self.store.read_bytes()
        self.command("add", "   ", expected=1)
        self.command("rename", "1", "", expected=1)
        self.assertEqual(self.store.read_bytes(), before)

    def test_missing_id_rejected_without_mutation(self):
        self.command("add", "valid")
        before = self.store.read_bytes()
        self.command("delete", "999", expected=1)
        self.assertEqual(self.store.read_bytes(), before)

    def test_duplicate_operation_returns_original_receipt(self):
        original = self.command("add", "first", operation="one")
        self.command("rename", "1", "later", operation="rename-one")
        self.assertEqual(self.command("add", "first", operation="one"), original)
        self.assertEqual(len(self.command("list")), 1)
        self.assertEqual(self.command("list")[0]["title"], "later")

    def test_conflicting_operation_rejected_and_no_temporary_files(self):
        self.command("add", "first", operation="one")
        before = self.store.read_bytes()
        self.command("add", "different", operation="one", expected=1)
        self.assertEqual(self.store.read_bytes(), before)
        self.assertEqual(list(self.store.parent.glob(".todo-*")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
