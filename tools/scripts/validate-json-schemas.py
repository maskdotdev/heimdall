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
    valid_fixture_paths = sorted(FIXTURE_ROOT.rglob("*.valid.json"))
    invalid_fixture_paths = sorted(FIXTURE_ROOT.rglob("*.invalid.json"))

    for fixture_path in valid_fixture_paths:
        schema_path = schema_for_fixture(fixture_path)
        if not schema_path.exists():
            errors.append(f"{fixture_path}: schema does not exist for fixture: {schema_path}")
            continue

        instance = load_json(fixture_path)
        schema = load_schema(schema_path)
        issues = validate_instance(instance, schema, schema_path, store)
        errors.extend(f"{fixture_path}: {issue.instance_path or '$'}: {issue.message}" for issue in issues)

    for fixture_path in invalid_fixture_paths:
        schema_path = schema_for_fixture(fixture_path)
        if not schema_path.exists():
            errors.append(f"{fixture_path}: schema does not exist for fixture: {schema_path}")
            continue

        expectation_path = fixture_path.with_suffix("").with_suffix(".expect.json")
        if not expectation_path.exists():
            errors.append(f"{fixture_path}: missing invalid fixture expectation: {expectation_path}")
            continue

        instance = load_json(fixture_path)
        schema = load_schema(schema_path)
        issues = validate_instance(instance, schema, schema_path, store)
        if not issues:
            errors.append(f"{fixture_path}: expected fixture to fail validation, but it passed")
            continue

        expectation = load_json(expectation_path)
        expected_error = validate_invalid_expectation(expectation_path, expectation)
        if expected_error is not None:
            errors.append(expected_error)
            continue

        instance_path = expectation["instancePath"]
        message_contains = expectation["messageContains"]
        matched = any(issue.instance_path == instance_path and message_contains in issue.message for issue in issues)
        if not matched:
            actual = "; ".join(f"{issue.instance_path or '$'}: {issue.message}" for issue in issues)
            errors.append(
                f"{fixture_path}: expected failure at {instance_path or '$'} containing {message_contains!r}; actual failures: {actual}"
            )
    return errors


def schema_for_fixture(fixture_path: Path) -> Path:
    relative = fixture_path.relative_to(FIXTURE_ROOT)
    fixture_name = relative.name
    if fixture_name.endswith(".valid.json"):
        schema_stem = fixture_name.removesuffix(".valid.json")
    elif fixture_name.endswith(".invalid.json"):
        schema_stem = fixture_name.removesuffix(".invalid.json").split(".", maxsplit=1)[0]
    else:
        raise ValueError(f"{fixture_path}: fixture must end with .valid.json or .invalid.json")
    schema_name = schema_stem + ".schema.json"
    return SCHEMA_ROOT / relative.with_name(schema_name)


def validate_invalid_expectation(expectation_path: Path, expectation: object) -> str | None:
    if not isinstance(expectation, dict):
        return f"{expectation_path}: expectation must be a JSON object"

    instance_path = expectation.get("instancePath")
    if not isinstance(instance_path, str):
        return f"{expectation_path}: instancePath must be a string"

    message_contains = expectation.get("messageContains")
    if not isinstance(message_contains, str) or not message_contains:
        return f"{expectation_path}: messageContains must be a non-empty string"

    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", action="store_true", help="validate valid and invalid fixtures under tests/fixtures/contracts")
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
        valid_fixture_count = len(sorted(FIXTURE_ROOT.rglob("*.valid.json"))) if FIXTURE_ROOT.exists() else 0
        invalid_fixture_count = len(sorted(FIXTURE_ROOT.rglob("*.invalid.json"))) if FIXTURE_ROOT.exists() else 0
        message += f" Validated {valid_fixture_count} valid and {invalid_fixture_count} invalid contract fixtures."
    print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
