import json

def load_store(path):
    if not path.exists():
        return {"pantry": {}, "recipes": {}}
    return json.loads(path.read_text(encoding="utf-8"))
