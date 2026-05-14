from __future__ import annotations

import json
from copy import deepcopy
from functools import cache
from pathlib import Path
from typing import Any, TypeAlias


JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

SCHEMA_NAME = "heimdall_reviewer_output"
REPO_ROOT = Path(__file__).resolve().parents[4]
REVIEWER_OUTPUT_SCHEMA = REPO_ROOT / "contracts" / "schemas" / "llm" / "reviewer-output.schema.json"
COMMON_SCHEMA = REPO_ROOT / "contracts" / "schemas" / "common.schema.json"
MODEL_UNSUPPORTED_KEYWORDS = {
    "$id",
    "$schema",
    "$defs",
    "description",
    "examples",
    "format",
    "maxItems",
    "maxLength",
    "minItems",
    "minLength",
    "minimum",
    "not",
    "pattern",
    "title",
    "uniqueItems",
}


def reviewer_output_response_format() -> JsonObject:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": SCHEMA_NAME,
            "strict": True,
            "schema": reviewer_output_schema(),
        },
    }


def reviewer_output_schema() -> JsonObject:
    return deepcopy(_cached_reviewer_output_schema())


@cache
def _cached_reviewer_output_schema() -> JsonObject:
    contract_schema = _load_json(REVIEWER_OUTPUT_SCHEMA)
    common_schema = _load_json(COMMON_SCHEMA)
    return _to_strict_model_schema(contract_schema, root_schema=contract_schema, common_schema=common_schema)


def _to_strict_model_schema(schema: JsonObject, *, root_schema: JsonObject, common_schema: JsonObject) -> JsonObject:
    resolved = _resolve_ref(schema, root_schema=root_schema, common_schema=common_schema)
    converted: JsonObject = {}

    for key, value in resolved.items():
        if key in MODEL_UNSUPPORTED_KEYWORDS:
            continue
        if key == "properties":
            required = set(_as_string_list(resolved.get("required", [])))
            properties = _as_object_map(value)
            converted_properties = {}
            for property_name, property_schema in properties.items():
                nested = _to_strict_model_schema(property_schema, root_schema=root_schema, common_schema=common_schema)
                if property_name == "schemaVersion" and nested.get("type") == "string":
                    nested["enum"] = ["1.0.0"]
                if property_name not in required:
                    nested = _nullable(nested)
                converted_properties[property_name] = nested
            converted["properties"] = converted_properties
            converted["required"] = list(properties.keys())
            continue
        if key == "items" and isinstance(value, dict):
            converted["items"] = _to_strict_model_schema(value, root_schema=root_schema, common_schema=common_schema)
            continue
        if key == "required":
            continue
        converted[key] = deepcopy(value)

    if converted.get("type") == "object":
        converted["additionalProperties"] = False
        converted.setdefault("properties", {})
        converted.setdefault("required", list(_as_object_map(converted["properties"]).keys()))

    return converted


def _resolve_ref(schema: JsonObject, *, root_schema: JsonObject, common_schema: JsonObject) -> JsonObject:
    ref = schema.get("$ref")
    if not isinstance(ref, str):
        return schema
    if ref.startswith("#/$defs/"):
        name = ref.removeprefix("#/$defs/")
        root_defs = _as_object(root_schema["$defs"])
        if name in root_defs:
            return root_defs[name]
        return _as_object(common_schema["$defs"])[name]
    if ref.startswith("../common.schema.json#/$defs/"):
        return _as_object(common_schema["$defs"])[ref.removeprefix("../common.schema.json#/$defs/")]
    raise ValueError(f"unsupported reviewer output schema reference: {ref}")


def _nullable(schema: JsonObject) -> JsonObject:
    nullable_schema = deepcopy(schema)
    schema_type = nullable_schema.get("type")
    if isinstance(schema_type, list):
        nullable_schema["type"] = schema_type if "null" in schema_type else [*schema_type, "null"]
    elif isinstance(schema_type, str):
        nullable_schema["type"] = [schema_type, "null"]
    else:
        nullable_schema["anyOf"] = [deepcopy(schema), {"type": "null"}]
    return nullable_schema


def _load_json(path: Path) -> JsonObject:
    return _as_object(json.loads(path.read_text(encoding="utf-8")))


def _as_object(value: JsonValue) -> JsonObject:
    if not isinstance(value, dict):
        raise TypeError("expected JSON object")
    return value


def _as_object_map(value: JsonValue) -> dict[str, JsonObject]:
    if not isinstance(value, dict):
        raise TypeError("expected JSON object map")
    return {key: _as_object(item) for key, item in value.items()}


def _as_string_list(value: JsonValue) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise TypeError("expected JSON string list")
    return value
