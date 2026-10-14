"""Small, file-backed Todo CLI; no third-party dependencies."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile


def load(store):
    if not store.exists():
        return {"next_id": 1, "items": [], "receipts": {}}
    return json.loads(store.read_text(encoding="utf-8"))


def save(store, state):
    store.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".todo-", dir=store.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, store)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def execute(store, action, item_id=None, title=None, operation_id=None):
    state = load(store)
    if action == "list":
        return state["items"]
    request = {"action": action, "id": item_id, "title": title}
    previous = state["receipts"].get(operation_id) if operation_id else None
    if previous:
        if previous["request"] != request:
            raise ValueError("operation ID reused with different input")
        return previous["result"]
    if action in ("add", "rename"):
        if not title or not title.strip():
            raise ValueError("title must not be empty")
        title = title.strip()
    if action == "add":
        item = {"id": state["next_id"], "title": title, "completed": False}
        state["next_id"] += 1
        state["items"].append(item)
    else:
        item = next((entry for entry in state["items"] if entry["id"] == item_id), None)
        if item is None:
            raise ValueError("todo not found")
        if action == "rename":
            item["title"] = title
        elif action == "complete":
            item["completed"] = True
        elif action == "reopen":
            item["completed"] = False
        elif action == "delete":
            state["items"].remove(item)
        else:
            raise ValueError("unsupported action")
    # Store a snapshot so later renames do not change an earlier receipt.
    result = dict(item)
    if operation_id:
        state["receipts"][operation_id] = {"request": request, "result": result}
    save(store, state)
    return result


def main():
    parser = argparse.ArgumentParser(description="File-backed TodoList")
    parser.add_argument("--store", type=Path, default=Path("data/todos.json"))
    parser.add_argument("--operation-id")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("list")
    actions.add_parser("add").add_argument("title")
    for name in ("rename", "complete", "reopen", "delete"):
        sub = actions.add_parser(name)
        sub.add_argument("id", type=int)
        if name == "rename":
            sub.add_argument("title")
    args = parser.parse_args()
    try:
        result = execute(args.store, args.action, getattr(args, "id", None),
                         getattr(args, "title", None), args.operation_id)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
