#!/usr/bin/env python3
"""Offline kitchen CLI: recipes, pantry inventory and cooking, local JSON store.

Only the Python standard library is used; no network, no child processes.
Usage: python3 kitchen.py [--store PATH] <command> [args...]
"""
import argparse
import json
import sys


def _fail(message):
    print(f"kitchen: {message}", file=sys.stderr)
    sys.exit(1)


def _load_store(path):
    """Return (data, existed). Read-only: never creates the file."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {"pantry": {}, "recipes": {}}, False
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"cannot read store {path}: {exc}")
    if not isinstance(data, dict):
        _fail(f"corrupt store {path}: top level must be an object")
    pantry = data.get("pantry", {})
    recipes = data.get("recipes", {})
    if not isinstance(pantry, dict) or not isinstance(recipes, dict):
        _fail(f"corrupt store {path}: pantry/recipes must be objects")
    return {"pantry": pantry, "recipes": recipes}, True


def _save_store(path, data):
    payload = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
    except OSError as exc:
        _fail(f"cannot write store {path}: {exc}")


def _positive_int(value, what):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _fail(f"invalid {what}: must be a positive integer, got {value!r}")
    return value


def _parse_ingredients(raw):
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        _fail(f"malformed recipe ingredients JSON: {exc}")
    if not isinstance(obj, dict) or not obj:
        _fail("recipe ingredients must be a nonempty JSON object")
    ingredients = {}
    for name, amount in obj.items():
        if not isinstance(name, str) or not name:
            _fail("ingredient names must be nonempty strings")
        _positive_int(amount, f"ingredient amount for {name!r}")
        ingredients[name] = amount
    return ingredients


def build_parser():
    parser = argparse.ArgumentParser(
        prog="kitchen.py",
        description="Offline kitchen CLI (recipes, pantry, cooking) with a local JSON store.",
    )
    parser.add_argument("--store", default="kitchen.json", metavar="PATH",
                        help="path to the JSON store file (default: kitchen.json)")
    sub = parser.add_subparsers(dest="command", required=True, metavar="<command>")

    p_pantry = sub.add_parser("pantry", help="pantry inventory commands")
    p_pantry_sub = p_pantry.add_subparsers(dest="action", required=True)
    p_pantry_sub.add_parser("list", help="list pantry ingredient amounts")
    p_set = p_pantry_sub.add_parser("set", help="set the amount of an ingredient")
    p_set.add_argument("name")
    p_set.add_argument("amount")

    p_recipe = sub.add_parser("recipe", help="recipe commands")
    p_recipe_sub = p_recipe.add_subparsers(dest="action", required=True)
    p_recipe_sub.add_parser("list", help="list saved recipes")
    p_add = p_recipe_sub.add_parser("add", help="add a recipe")
    p_add.add_argument("name")
    p_add.add_argument("ingredients_json", metavar="INGREDIENTS_JSON")

    p_cook = sub.add_parser("can-cook", help="check whether a recipe can be cooked")
    p_cook.add_argument("name")
    p_do = sub.add_parser("cook", help="cook a recipe, consuming pantry ingredients")
    p_do.add_argument("name")
    return parser


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    args = build_parser().parse_args(argv)
    store = args.store
    data, _existed = _load_store(store)

    if args.command == "pantry" and args.action == "list":
        result = data["pantry"]
    elif args.command == "pantry" and args.action == "set":
        try:
            amount = int(args.amount)
        except ValueError:
            _fail(f"invalid amount {args.amount!r}: must be an integer")
        if amount < 0:
            _fail(f"invalid amount {amount}: must be a nonnegative integer")
        if not args.name:
            _fail("ingredient name must not be empty")
        data["pantry"][args.name] = amount
        _save_store(store, data)
        result = {"name": args.name, "amount": amount}
    elif args.command == "recipe" and args.action == "list":
        result = data["recipes"]
    elif args.command == "recipe" and args.action == "add":
        if not args.name:
            _fail("recipe name must not be empty")
        ingredients = _parse_ingredients(args.ingredients_json)
        data["recipes"][args.name] = ingredients
        _save_store(store, data)
        result = {"name": args.name, "ingredients": ingredients}
    elif args.command == "can-cook":
        recipe = data["recipes"].get(args.name)
        if recipe is None:
            _fail(f"unknown recipe {args.name!r}")
        missing = {}
        for ingredient, required in recipe.items():
            available = data["pantry"].get(ingredient, 0)
            if available < required:
                missing[ingredient] = required - available
        result = {"can_cook": not missing, "missing": missing}
    elif args.command == "cook":
        recipe = data["recipes"].get(args.name)
        if recipe is None:
            _fail(f"unknown recipe {args.name!r}")
        missing = {}
        for ingredient, required in recipe.items():
            available = data["pantry"].get(ingredient, 0)
            if available < required:
                missing[ingredient] = required - available
        if missing:
            _fail(f"insufficient stock to cook {args.name!r}; missing: {json.dumps(missing, ensure_ascii=False)}")
        for ingredient, required in recipe.items():
            data["pantry"][ingredient] = data["pantry"].get(ingredient, 0) - required
        _save_store(store, data)
        result = {"cooked": args.name}
    else:  # pragma: no cover - argparse enforces choices
        _fail(f"unknown command {args.command!r}")

    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
