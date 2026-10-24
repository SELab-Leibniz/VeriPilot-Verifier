import json

def load_store(path):
    if not path.exists():
        return {"pantry": {}, "recipes": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"pantry": {}, "recipes": {}}
