def save(path, state):
    path.write_text(json.dumps(state), encoding="utf-8")
