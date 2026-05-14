import unittest
from typing import Any

from review_worker.reviewer_output_schema import reviewer_output_response_format


class ReviewerOutputSchemaTests(unittest.TestCase):
    def test_response_format_uses_strict_json_schema(self) -> None:
        response_format = reviewer_output_response_format()

        self.assertEqual(response_format["type"], "json_schema")
        self.assertEqual(response_format["json_schema"]["name"], "heimdall_reviewer_output")
        self.assertTrue(response_format["json_schema"]["strict"])
        self.assert_strict_object_schema(response_format["json_schema"]["schema"])

    def test_optional_contract_fields_are_nullable_and_required_for_strict_mode(self) -> None:
        schema = reviewer_output_response_format()["json_schema"]["schema"]
        finding = schema["properties"]["findings"]["items"]
        evidence = finding["properties"]["evidence"]["items"]

        self.assertEqual(schema["required"], ["schemaVersion", "summary", "findings", "modelMetadata"])
        self.assertEqual(schema["properties"]["summary"]["type"], ["string", "null"])
        self.assertEqual(schema["properties"]["modelMetadata"]["type"], ["object", "null"])
        self.assertEqual(finding["properties"]["location"]["type"], ["object", "null"])
        self.assertEqual(finding["properties"]["suggestedFix"]["type"], ["string", "null"])
        self.assertEqual(finding["properties"]["reviewStandardRuleIds"]["type"], ["array", "null"])
        self.assertEqual(evidence["properties"]["location"]["type"], ["object", "null"])

    def assert_strict_object_schema(self, schema: dict[str, Any]) -> None:
        schema_type = schema.get("type")
        if schema_type == "object" or schema_type == ["object", "null"]:
            properties = schema.get("properties", {})
            self.assertFalse(schema.get("additionalProperties"))
            self.assertEqual(set(schema.get("required", [])), set(properties.keys()))
            for nested in properties.values():
                self.assert_strict_object_schema(nested)

        items = schema.get("items")
        if isinstance(items, dict):
            self.assert_strict_object_schema(items)


if __name__ == "__main__":
    unittest.main()
