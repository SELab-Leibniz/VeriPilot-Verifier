import json
import sys

if __name__ == "__main__":
    print(json.dumps({"error": "Unknown recipe"}))
    raise SystemExit(0)
