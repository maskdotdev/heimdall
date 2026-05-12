#!/usr/bin/env python3
"""Shared JSON Schema loading and validation helpers for Heimdall contracts."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urlparse


REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_ROOT = REPO_ROOT / "contracts" / "schemas"
FIXTURE_ROOT = REPO_ROOT / "tests" / "fixtures" / "contracts"


@dataclass(frozen=True)
class ValidationIssue:
    path: Path
    instance_path: str
    message: str

    def format(self) -> str:
        location = self.instance_path or "$"
        return f"{self.path}: {location}: {self.message}"


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as error:
        raise ValueError(f"{path}: invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}") from error


def load_schema(path: Path) -> dict[str, Any]:
    value = load_json(path)
    if not isinstance(value, dict):
        raise ValueError(f"{path}: top-level schema must be a JSON object")
    return value


def schema_paths() -> list[Path]:
    return sorted(SCHEMA_ROOT.rglob("*.schema.json"))


def json_paths() -> list[Path]:
    return sorted(SCHEMA_ROOT.rglob("*.json"))


class SchemaStore:
    def __init__(self, root: Path = SCHEMA_ROOT) -> None:
        self.root = root.resolve()
        self.schemas: dict[Path, dict[str, Any]] = {}
        for path in schema_paths():
            self.schemas[path.resolve()] = load_schema(path)

    def resolve_ref(self, current_path: Path, ref: str) -> tuple[Path, Any]:
        ref_path, fragment = urldefrag(ref)
        if ref_path.startswith(("http://", "https://")):
            target_path = self._path_for_id(ref_path)
        else:
            target_path = (current_path.parent / ref_path).resolve() if ref_path else current_path.resolve()

        if target_path not in self.schemas:
            raise ValueError(f"{current_path}: $ref target does not exist: {ref}")

        target: Any = self.schemas[target_path]
        if fragment:
            target = resolve_pointer(target, fragment)
        return target_path, target

    def _path_for_id(self, schema_id: str) -> Path:
        for path, schema in self.schemas.items():
            if schema.get("$id") == schema_id:
                return path
        raise ValueError(f"schema $id not found: {schema_id}")


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


def resolve_pointer(document: Any, pointer: str) -> Any:
    if pointer in ("", "/"):
        return document
    if not pointer.startswith("/"):
        raise ValueError(f"JSON pointer fragment must start with '/': {pointer}")

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
        raise ValueError(f"JSON pointer fragment does not resolve: {pointer}")
    return current


def pointer_exists(document: Any, pointer: str) -> bool:
    try:
        resolve_pointer(document, pointer)
    except ValueError:
        return False
    return True


def validate_instance(
    instance: Any,
    schema: dict[str, Any],
    schema_path: Path,
    store: SchemaStore,
) -> list[ValidationIssue]:
    validator = _InstanceValidator(store)
    validator.validate(instance, schema, schema_path.resolve(), "")
    return validator.issues


class _InstanceValidator:
    def __init__(self, store: SchemaStore) -> None:
        self.store = store
        self.issues: list[ValidationIssue] = []

    def validate(self, instance: Any, schema: dict[str, Any], schema_path: Path, instance_path: str) -> None:
        if "$ref" in schema:
            target_path, target_schema = self.store.resolve_ref(schema_path, schema["$ref"])
            self.validate(instance, target_schema, target_path, instance_path)
            return

        if "allOf" in schema:
            for nested_schema in schema["allOf"]:
                self.validate(instance, nested_schema, schema_path, instance_path)

        if "anyOf" in schema:
            if not any(self._matches(instance, nested_schema, schema_path, instance_path) for nested_schema in schema["anyOf"]):
                self._issue(schema_path, instance_path, "does not match any allowed schema")
            return

        if "oneOf" in schema:
            matches = sum(1 for nested_schema in schema["oneOf"] if self._matches(instance, nested_schema, schema_path, instance_path))
            if matches != 1:
                self._issue(schema_path, instance_path, f"matches {matches} schemas, expected exactly one")
            return

        if "not" in schema and self._matches(instance, schema["not"], schema_path, instance_path):
            self._issue(schema_path, instance_path, "matches a disallowed schema")
            return

        if "enum" in schema and instance not in schema["enum"]:
            self._issue(schema_path, instance_path, f"must be one of {schema['enum']!r}")

        expected_type = schema.get("type")
        if isinstance(expected_type, list):
            if not any(self._is_type(instance, item) for item in expected_type):
                self._issue(schema_path, instance_path, f"must be one of types {expected_type!r}")
                return
        elif isinstance(expected_type, str):
            if not self._is_type(instance, expected_type):
                self._issue(schema_path, instance_path, f"must be type {expected_type}")
                return

        if isinstance(instance, dict):
            self._validate_object(instance, schema, schema_path, instance_path)
        elif isinstance(instance, list):
            self._validate_array(instance, schema, schema_path, instance_path)
        elif isinstance(instance, str):
            self._validate_string(instance, schema, schema_path, instance_path)
        elif isinstance(instance, (int, float)) and not isinstance(instance, bool):
            self._validate_number(instance, schema, schema_path, instance_path)

    def _matches(self, instance: Any, schema: dict[str, Any], schema_path: Path, instance_path: str) -> bool:
        nested = _InstanceValidator(self.store)
        nested.validate(instance, schema, schema_path, instance_path)
        return not nested.issues

    def _validate_object(self, instance: dict[str, Any], schema: dict[str, Any], schema_path: Path, instance_path: str) -> None:
        required = schema.get("required", [])
        if isinstance(required, list):
            for key in required:
                if key not in instance:
                    self._issue(schema_path, instance_path, f"missing required property '{key}'")

        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            for key, value in instance.items():
                property_path = f"{instance_path}/{_escape_pointer(key)}"
                if key in properties:
                    self.validate(value, properties[key], schema_path, property_path)

        additional = schema.get("additionalProperties", True)
        if additional is False and isinstance(properties, dict):
            allowed = set(properties)
            for key in sorted(set(instance) - allowed):
                self._issue(schema_path, f"{instance_path}/{_escape_pointer(key)}", "additional property is not allowed")
        elif isinstance(additional, dict) and isinstance(properties, dict):
            for key, value in instance.items():
                if key not in properties:
                    self.validate(value, additional, schema_path, f"{instance_path}/{_escape_pointer(key)}")

        property_names = schema.get("propertyNames")
        if isinstance(property_names, dict):
            for key in instance:
                self.validate(key, property_names, schema_path, f"{instance_path}/{_escape_pointer(key)}")

    def _validate_array(self, instance: list[Any], schema: dict[str, Any], schema_path: Path, instance_path: str) -> None:
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(instance) < min_items:
            self._issue(schema_path, instance_path, f"must contain at least {min_items} items")

        max_items = schema.get("maxItems")
        if isinstance(max_items, int) and len(instance) > max_items:
            self._issue(schema_path, instance_path, f"must contain at most {max_items} items")

        if schema.get("uniqueItems") is True:
            seen: set[str] = set()
            for item in instance:
                marker = json.dumps(item, sort_keys=True, separators=(",", ":"))
                if marker in seen:
                    self._issue(schema_path, instance_path, "must contain unique items")
                    break
                seen.add(marker)

        items = schema.get("items")
        if isinstance(items, dict):
            for index, value in enumerate(instance):
                self.validate(value, items, schema_path, f"{instance_path}/{index}")

    def _validate_string(self, instance: str, schema: dict[str, Any], schema_path: Path, instance_path: str) -> None:
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and len(instance) < min_length:
            self._issue(schema_path, instance_path, f"must be at least {min_length} characters")

        max_length = schema.get("maxLength")
        if isinstance(max_length, int) and len(instance) > max_length:
            self._issue(schema_path, instance_path, f"must be at most {max_length} characters")

        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, instance) is None:
            self._issue(schema_path, instance_path, f"must match pattern {pattern!r}")

        value_format = schema.get("format")
        if value_format == "date-time" and not _is_date_time(instance):
            self._issue(schema_path, instance_path, "must be an RFC 3339 date-time string")
        elif value_format == "uri" and not _is_uri(instance):
            self._issue(schema_path, instance_path, "must be an absolute URI")

    def _validate_number(self, instance: int | float, schema: dict[str, Any], schema_path: Path, instance_path: str) -> None:
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and instance < minimum:
            self._issue(schema_path, instance_path, f"must be >= {minimum}")

        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and instance > maximum:
            self._issue(schema_path, instance_path, f"must be <= {maximum}")

    def _is_type(self, instance: Any, expected_type: str) -> bool:
        if expected_type == "object":
            return isinstance(instance, dict)
        if expected_type == "array":
            return isinstance(instance, list)
        if expected_type == "string":
            return isinstance(instance, str)
        if expected_type == "integer":
            return isinstance(instance, int) and not isinstance(instance, bool)
        if expected_type == "number":
            return isinstance(instance, (int, float)) and not isinstance(instance, bool)
        if expected_type == "boolean":
            return isinstance(instance, bool)
        if expected_type == "null":
            return instance is None
        return True

    def _issue(self, schema_path: Path, instance_path: str, message: str) -> None:
        self.issues.append(ValidationIssue(schema_path, instance_path, message))


def _escape_pointer(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _is_date_time(value: str) -> bool:
    candidate = value.removesuffix("Z") + "+00:00" if value.endswith("Z") else value
    try:
        datetime.fromisoformat(candidate)
    except ValueError:
        return False
    return "T" in value


def _is_uri(value: str) -> bool:
    parsed = urlparse(value)
    return bool(parsed.scheme and (parsed.netloc or parsed.scheme == "urn"))
