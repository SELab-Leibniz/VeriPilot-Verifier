"""Read-only acceptance check for the tiny delivery-note Skill."""
import argparse
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()
    if not args.project.is_absolute():
        parser.error("--project must be an absolute directory")
    try:
        note = json.loads((args.project / "note.json").read_text(encoding="utf-8"))
        if note != {"title": args.title, "status": "ready"}:
            raise ValueError("note.json must contain exactly the requested title and status=ready")
    except (OSError, ValueError) as error:
        print(f"NOTE_INVALID: {error}", file=sys.stderr)
        return 1
    print("NOTE_VERIFIED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
