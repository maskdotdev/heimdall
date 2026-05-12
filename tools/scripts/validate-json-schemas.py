#!/usr/bin/env python3
"""Validate Heimdall JSON Schema files without third-party dependencies.

This check is intentionally lightweight for the scaffold stage. It verifies
that schemas parse as JSON, top-level $id values are unique, and local relative
$ref targets point to existing files and definitions. Full instance validation
can be added later with a JSON Schema implementation in the relevant runtime.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag


REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_ROOT = REPO_ROOT / "contracts" / "schemas"


def load_schema(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except json.JSONDecodeError as error:
        raise ValueError(f"{path}: invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}") from error

    if not isinstance(value, dict):
        raise ValueError(f"{path}: top-level schema must be a JSON object")
    return value


def walk_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            if key == "$ref" and isinstance(nested, str):
                refs.append(nested)
            else:
                refs.extend(walk_refs(nested))
    elif isinstance(value, list):
        for item in value:
            refs.extend(walk_refs(item))
    return refs


def resolve_pointer(document: Any, pointer: str) -> bool:
    if pointer in ("", "/"):
        return True
    if not pointer.startswith("/"):
        return False

    current = document
    for raw_part in pointer.lstrip("/").split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and part in current:
            current = current[part]
            continue
        if isinstance(current, list) and part.isdigit():
            index = int(part)
            if 0 <= index < len(current):
                current = current[index]
                continue
        return False
    return True


def validate_refs(path: Path, schema: dict[str, Any], schemas: dict[Path, dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for ref in walk_refs(schema):
        ref_path, fragment = urldefrag(ref)

        if ref_path.startswith("http://") or ref_path.startswith("https://"):
            continue

        target_path = (path.parent / ref_path).resolve() if ref_path else path.resolve()
        try:
            target_relative = target_path.relative_to(SCHEMA_ROOT.resolve())
        except ValueError:
            errors.append(f"{path}: $ref leaves schema root: {ref}")
            continue

        target_schema_path = SCHEMA_ROOT / target_relative
        if target_schema_path not in schemas:
            errors.append(f"{path}: $ref target does not exist: {ref}")
            continue

        if fragment and not resolve_pointer(schemas[target_schema_path], fragment):
            errors.append(f"{path}: $ref fragment does not resolve: {ref}")
    return errors


def main() -> int:
    json_paths = sorted(SCHEMA_ROOT.rglob("*.json"))
    schema_paths = [path for path in json_paths if path.name.endswith(".schema.json")]
    if not schema_paths:
        print("No JSON Schema files found.", file=sys.stderr)
        return 1

    errors: list[str] = []
    schemas: dict[Path, dict[str, Any]] = {}
    ids: dict[str, Path] = {}

    for path in json_paths:
        try:
            load_schema(path)
        except ValueError as error:
            errors.append(str(error))

    for path in schema_paths:
        try:
            schema = load_schema(path)
        except ValueError as error:
            errors.append(str(error))
            continue

        schemas[path] = schema
        schema_id = schema.get("$id")
        if not isinstance(schema_id, str) or not schema_id:
            errors.append(f"{path}: missing top-level $id")
        elif schema_id in ids:
            errors.append(f"{path}: duplicate $id also used by {ids[schema_id]}")
        else:
            ids[schema_id] = path

    for path, schema in schemas.items():
        errors.extend(validate_refs(path, schema, schemas))

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    print(f"Validated {len(schema_paths)} JSON Schema files and parsed {len(json_paths)} JSON files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
