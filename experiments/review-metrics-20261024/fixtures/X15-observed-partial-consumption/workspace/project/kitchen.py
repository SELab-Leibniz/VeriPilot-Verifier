#!/usr/bin/env python3
"""Offline kitchen CLI: recipes, pantry inventory and cooking.

Standard library only. Persists state to a local JSON file supplied via the
global ``--store PATH`` option. No network access, no child processes.
"""

import argparse
import json
import sys
from pathlib import Path


class KitchenError(Exception):
    """Raised for user-facing validation failures (nonzero exit, stderr)."""


def _empty_store():
    return {"pantry": {}, "recipes": {}}


def load_store(path):
    """Read the JSON store. A missing file yields empty defaults and is not created."""
    p = Path(path)
    if not p.exists():
        return _empty_store()
    try:
        with p.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise KitchenError(f"store {path} is not valid JSON: {exc}")
    except OSError as exc:
        raise KitchenError(f"cannot read store {path}: {exc}")
    if not isinstance(data, dict):
        raise KitchenError(f"store {path} must contain a JSON object")
    if "pantry" not in data or not isinstance(data["pantry"], dict):
        data["pantry"] = {}
    if "recipes" not in data or not isinstance(data["recipes"], dict):
        data["recipes"] = {}
    return data


def save_store(path, data):
    """Persist the store atomically (temp file + rename)."""
    p = Path(path)
    if p.parent and str(p.parent) not in ("", "."):
        p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    tmp.replace(p)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_pantry_list(args):
    store = load_store(args.store)
    print(json.dumps(store["pantry"], ensure_ascii=False))


def cmd_pantry_set(args):
    try:
        amount = int(args.amount)
    except (TypeError, ValueError):
        raise KitchenError(
            f"invalid amount {args.amount!r}: must be a nonnegative integer"
        )
    if amount < 0:
        raise KitchenError(
            f"invalid amount {amount}: must be nonnegative"
        )
    store = load_store(args.store)
    store["pantry"][args.name] = amount
    save_store(args.store, store)
    print(json.dumps({"name": args.name, "amount": amount}, ensure_ascii=False))


def cmd_recipe_list(args):
    store = load_store(args.store)
    print(json.dumps(store["recipes"], ensure_ascii=False))


def cmd_recipe_add(args):
    try:
        ingredients = json.loads(args.ingredients)
    except json.JSONDecodeError as exc:
        raise KitchenError(f"malformed recipe JSON: {exc}")
    if not isinstance(ingredients, dict) or not ingredients:
        raise KitchenError("recipe ingredients must be a nonempty JSON object")
    for ing, need in ingredients.items():
        if not isinstance(ing, str) or not ing:
            raise KitchenError(
                f"ingredient name must be a nonempty string, got {ing!r}"
            )
        if isinstance(need, bool) or not isinstance(need, int) or need <= 0:
            raise KitchenError(
                f"ingredient {ing!r} amount must be a positive integer "
                f"(got {need!r})"
            )
    store = load_store(args.store)
    store["recipes"][args.name] = ingredients
    save_store(args.store, store)
    print(
        json.dumps(
            {"name": args.name, "ingredients": ingredients},
            ensure_ascii=False,
        )
    )


def _shortfall(pantry, recipe):
    missing = {}
    for ing, need in recipe.items():
        have = pantry.get(ing, 0)
        if have < need:
            missing[ing] = need - have
    return missing


def cmd_can_cook(args):
    store = load_store(args.store)
    recipe = store["recipes"].get(args.name)
    if recipe is None:
        raise KitchenError(f"unknown recipe: {args.name!r}")
    missing = _shortfall(store["pantry"], recipe)
    print(
        json.dumps(
            {"can_cook": not missing, "missing": missing},
            ensure_ascii=False,
        )
    )


def cmd_cook(args):
    store = load_store(args.store)
    recipe = store["recipes"].get(args.name)
    if recipe is None:
        raise KitchenError(f"unknown recipe: {args.name!r}")
    pantry = store["pantry"]
    for ing in sorted(recipe, reverse=True):
        need = recipe[ing]
        if pantry.get(ing, 0) < need:
            save_store(args.store, store)
            raise KitchenError(f"Insufficient {ing}: need {need}, have {pantry.get(ing, 0)}.")
        pantry[ing] = pantry.get(ing, 0) - need
    save_store(args.store, store)
    print(json.dumps({"cooked": args.name}, ensure_ascii=False))



# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="kitchen.py",
        description="Offline kitchen CLI: recipes, pantry and cooking.",
    )
    parser.add_argument("--store", required=True, help="path to the JSON store file")

    sub = parser.add_subparsers(dest="command", required=True)

    pantry = sub.add_parser("pantry", help="manage pantry inventory")
    pantry_sub = pantry.add_subparsers(dest="pantry_cmd", required=True)
    pantry_list = pantry_sub.add_parser("list", help="list all pantry amounts")
    pantry_list.set_defaults(func=cmd_pantry_list)
    pantry_set = pantry_sub.add_parser("set", help="set an ingredient amount")
    pantry_set.add_argument("name", help="ingredient name (Unicode preserved)")
    pantry_set.add_argument("amount", help="nonnegative integer amount")
    pantry_set.set_defaults(func=cmd_pantry_set)

    recipe = sub.add_parser("recipe", help="manage recipes")
    recipe_sub = recipe.add_subparsers(dest="recipe_cmd", required=True)
    recipe_list = recipe_sub.add_parser("list", help="list all recipes")
    recipe_list.set_defaults(func=cmd_recipe_list)
    recipe_add = recipe_sub.add_parser("add", help="add or replace a recipe")
    recipe_add.add_argument("name", help="recipe name (Unicode preserved)")
    recipe_add.add_argument(
        "ingredients",
        help='JSON object of ingredient -> positive integer, e.g. {"番茄":2}',
    )
    recipe_add.set_defaults(func=cmd_recipe_add)

    can_cook = sub.add_parser("can-cook", help="check whether a recipe can be cooked")
    can_cook.add_argument("name", help="recipe name")
    can_cook.set_defaults(func=cmd_can_cook)

    cook = sub.add_parser("cook", help="cook a recipe, subtracting ingredients")
    cook.add_argument("name", help="recipe name")
    cook.set_defaults(func=cmd_cook)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except KitchenError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
