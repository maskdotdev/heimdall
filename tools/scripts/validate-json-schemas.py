#!/usr/bin/env python3
"""Validate Heimdall JSON Schemas and contract fixtures."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import urldefrag

from contract_schema import FIXTURE_ROOT, SCHEMA_ROOT, SchemaStore, json_paths, load_json, load_schema, pointer_exists, schema_paths, validate_instance, walk_refs


def validate_schema_structure(store: SchemaStore) -> list[str]:
    errors: list[str] = []
    ids: dict[str, Path] = {}

    for path in json_paths():
        try:
            load_json(path)
        except ValueError as error:
            errors.append(str(error))

    for path in schema_paths():
        try:
            schema = load_schema(path)
        except ValueError as error:
            errors.append(str(error))
            continue

        schema_id = schema.get("$id")
        if not isinstance(schema_id, str) or not schema_id:
            errors.append(f"{path}: missing top-level $id")
        elif schema_id in ids:
            errors.append(f"{path}: duplicate $id also used by {ids[schema_id]}")
        else:
            ids[schema_id] = path

        for ref in walk_refs(schema):
            ref_path, fragment = urldefrag(ref)
            if ref_path.startswith(("http://", "https://")):
                continue

            target_path = (path.parent / ref_path).resolve() if ref_path else path.resolve()
            try:
                target_path.relative_to(SCHEMA_ROOT.resolve())
            except ValueError:
                errors.append(f"{path}: $ref leaves schema root: {ref}")
                continue

            if target_path not in store.schemas:
                errors.append(f"{path}: $ref target does not exist: {ref}")
                continue

            if fragment and not pointer_exists(store.schemas[target_path], fragment):
                errors.append(f"{path}: $ref fragment does not resolve: {ref}")

    return errors


def validate_fixtures(store: SchemaStore) -> list[str]:
    errors: list[str] = []
    fixture_paths = sorted(FIXTURE_ROOT.rglob("*.valid.json"))
    for fixture_path in fixture_paths:
        schema_path = schema_for_fixture(fixture_path)
        if not schema_path.exists():
            errors.append(f"{fixture_path}: schema does not exist for fixture: {schema_path}")
            continue

        instance = load_json(fixture_path)
        schema = load_schema(schema_path)
        issues = validate_instance(instance, schema, schema_path, store)
        errors.extend(f"{fixture_path}: {issue.instance_path or '$'}: {issue.message}" for issue in issues)
    return errors


def schema_for_fixture(fixture_path: Path) -> Path:
    relative = fixture_path.relative_to(FIXTURE_ROOT)
    schema_name = relative.name.removesuffix(".valid.json") + ".schema.json"
    return SCHEMA_ROOT / relative.with_name(schema_name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", action="store_true", help="validate tests/fixtures/contracts/*.valid.json against matching schemas")
    args = parser.parse_args()

    try:
        store = SchemaStore()
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1

    errors = validate_schema_structure(store)
    if args.fixtures:
        errors.extend(validate_fixtures(store))

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    message = f"Validated {len(schema_paths())} JSON Schema files and parsed {len(json_paths())} JSON files."
    if args.fixtures:
        fixture_count = len(sorted(FIXTURE_ROOT.rglob("*.valid.json"))) if FIXTURE_ROOT.exists() else 0
        message += f" Validated {fixture_count} contract fixtures."
    print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
