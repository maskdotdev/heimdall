import json
import os
import unittest
from io import StringIO
from unittest.mock import patch

from contract_types import ReviewerOutput
from review_worker.backends.codex_app_server import (
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    CodexAppServerAgenticReviewerProvider,
    CodexAppServerClient,
    CodexAppServerConfig,
    CodexAppServerReviewerProvider,
    build_agentic_codex_review_prompt,
    build_codex_review_prompt,
    parse_reviewer_output,
    read_only_repository_turn_options,
)

from test_finding_quality import context_bundle


class CodexAppServerBackendTests(unittest.TestCase):
    def test_builds_review_prompt_for_context_bundle(self) -> None:
        prompt = build_codex_review_prompt(request())

        self.assertIn("Do not inspect or edit files", prompt)
        self.assertIn('"changedFiles"', prompt)
        self.assertIn("ReviewerOutput", prompt)
        self.assertIn('Use "correctness" for bugs', prompt)
        self.assertIn('Use "diff-line" for changed diff lines; never use "changed_line"', prompt)

    def test_builds_agentic_review_prompt_with_repository_exploration_bounds(self) -> None:
        prompt = build_agentic_codex_review_prompt(request())

        self.assertIn("read-only checkout", prompt)
        self.assertIn("dependencyFrontier", prompt)
        self.assertIn("relatedTests", prompt)
        self.assertIn("Do not edit files", prompt)
        self.assertIn("Do not inspect benchmark goldens", prompt)
        self.assertIn('"changedFiles"', prompt)
        self.assertIn("ReviewerOutput", prompt)

    def test_parses_reviewer_output_from_raw_json(self) -> None:
        output = parse_reviewer_output(json.dumps({"schemaVersion": "1.0.0", "summary": "Done", "findings": []}))

        self.assertIsInstance(output, ReviewerOutput)
        self.assertEqual(output.findings, [])

    def test_parses_reviewer_output_from_wrapped_agent_text(self) -> None:
        output = parse_reviewer_output('Here is the result:\n{"schemaVersion":"1.0.0","summary":"Done","findings":[]}')

        self.assertEqual(output.schemaVersion, "1.0.0")

    def test_client_drives_app_server_json_rpc_flow(self) -> None:
        process = FakeProcess(
            [
                {"id": 1, "result": {"userAgent": "test"}},
                {"id": 2, "result": {"thread": {"id": "thr_1"}}},
                {"id": 3, "result": {"turn": {"id": "turn_1"}}},
                {"method": "item/agentMessage/delta", "params": {"itemId": "msg_1", "delta": '{"schemaVersion":"1.0.0","summary":"Done",'}},
                {"method": "item/agentMessage/delta", "params": {"itemId": "msg_1", "delta": '"findings":[]}'}},
                {
                    "method": "item/completed",
                    "params": {"item": {"type": "agentMessage", "id": "msg_1", "text": '{"schemaVersion":"1.0.0","summary":"Done","findings":[]}'}},
                },
                {"method": "thread/status/changed", "params": {"status": {"type": "idle"}}},
                {"id": 4, "result": {}},
            ]
        )

        with patch("review_worker.backends.codex_app_server.subprocess.Popen", return_value=process):
            client = CodexAppServerClient(CodexAppServerConfig(command=("codex", "app-server"), model="test-model", timeout_seconds=1))
            try:
                output = client.review(request())
            finally:
                client.close()

        sent_messages = [json.loads(line) for line in process.stdin.lines]
        self.assertEqual([message["method"] for message in sent_messages[:4]], ["initialize", "initialized", "thread/start", "turn/start"])
        self.assertEqual(sent_messages[4]["method"], "thread/archive")
        self.assertEqual(sent_messages[4]["params"]["threadId"], "thr_1")
        self.assertEqual(sent_messages[2]["params"]["model"], "test-model")
        self.assertEqual(sent_messages[2]["params"]["reasoningEffort"], DEFAULT_REASONING_EFFORT)
        self.assertEqual(output.schemaVersion, "1.0.0")
        self.assertEqual(output.findings, [])
        self.assertIn("initializeMs", client.last_timing or {})
        self.assertIn("threadStartMs", client.last_timing or {})
        self.assertIn("turnMs", client.last_timing or {})
        self.assertIn("archiveMs", client.last_timing or {})
        self.assertIn("parseMs", client.last_timing or {})

    def test_reviewer_provider_reuses_app_server_process(self) -> None:
        process = FakeProcess(
            [
                {"id": 1, "result": {"userAgent": "test"}},
                {"id": 2, "result": {"thread": {"id": "thr_1"}}},
                {"id": 3, "result": {"turn": {"id": "turn_1"}}},
                {"method": "item/agentMessage/delta", "params": {"itemId": "msg_1", "delta": '{"schemaVersion":"1.0.0","summary":"One","findings":[]}'}},
                {"method": "thread/status/changed", "params": {"status": {"type": "idle"}}},
                {"id": 4, "result": {}},
                {"id": 5, "result": {"thread": {"id": "thr_2"}}},
                {"id": 6, "result": {"turn": {"id": "turn_2"}}},
                {"method": "item/agentMessage/delta", "params": {"itemId": "msg_2", "delta": '{"schemaVersion":"1.0.0","summary":"Two","findings":[]}'}},
                {"method": "thread/status/changed", "params": {"status": {"type": "idle"}}},
                {"id": 7, "result": {}},
            ]
        )
        config = CodexAppServerConfig(command=("codex", "app-server"), model="test-model", timeout_seconds=1)
        provider = CodexAppServerReviewerProvider(config)

        with patch("review_worker.backends.codex_app_server.subprocess.Popen", return_value=process) as popen:
            first = provider.review(request())
            first_timing = dict(provider.last_timing or {})
            second = provider.review(request())
            second_timing = dict(provider.last_timing or {})
            provider.close()

        sent_messages = [json.loads(line) for line in process.stdin.lines]
        methods = [message["method"] for message in sent_messages]
        popen.assert_called_once()
        self.assertEqual(methods.count("initialize"), 1)
        self.assertEqual(methods.count("thread/start"), 2)
        self.assertEqual(methods.count("thread/archive"), 2)
        self.assertEqual(first.summary, "One")
        self.assertEqual(second.summary, "Two")
        self.assertGreaterEqual(first_timing["processStartMs"], 0)
        self.assertEqual(second_timing["processStartMs"], 0)
        self.assertEqual(second_timing["initializeMs"], 0)
        self.assertTrue(process.terminated)

    def test_config_defaults_to_gpt_55_low_reasoning(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = CodexAppServerConfig.from_env()

        self.assertEqual(config.model, DEFAULT_MODEL)
        self.assertEqual(config.model, "gpt-5.5")
        self.assertEqual(config.reasoning_effort, "low")

    def test_config_allows_reasoning_effort_override(self) -> None:
        with patch.dict(os.environ, {"HEIMDALL_CODEX_APP_SERVER_REASONING_EFFORT": "medium"}):
            config = CodexAppServerConfig.from_env()

        self.assertEqual(config.reasoning_effort, "medium")

    def test_agentic_provider_requires_explicit_repository_checkout(self) -> None:
        provider = CodexAppServerAgenticReviewerProvider(CodexAppServerConfig(command=("codex", "app-server"), model="test-model"))

        with self.assertRaisesRegex(ValueError, "HEIMDALL_CODEX_APP_SERVER_CWD"):
            provider.review(request())

    def test_agentic_provider_uses_read_only_repository_turn_options(self) -> None:
        process = FakeProcess(
            [
                {"id": 1, "result": {"userAgent": "test"}},
                {"id": 2, "result": {"thread": {"id": "thr_1"}}},
                {"id": 3, "result": {"turn": {"id": "turn_1"}}},
                {"method": "item/agentMessage/delta", "params": {"itemId": "msg_1", "delta": '{"schemaVersion":"1.0.0","summary":"Done","findings":[]}'}},
                {"method": "thread/status/changed", "params": {"status": {"type": "idle"}}},
                {"id": 4, "result": {}},
            ]
        )
        config = CodexAppServerConfig(command=("codex", "app-server"), model="test-model", cwd="/repo", timeout_seconds=1)
        provider = CodexAppServerAgenticReviewerProvider(config)

        with patch("review_worker.backends.codex_app_server.subprocess.Popen", return_value=process):
            output = provider.review(request())

        sent_messages = [json.loads(line) for line in process.stdin.lines]
        turn_params = sent_messages[3]["params"]
        self.assertEqual(turn_params["cwd"], "/repo")
        self.assertEqual(turn_params["effort"], DEFAULT_REASONING_EFFORT)
        self.assertEqual(turn_params["sandboxPolicy"]["type"], "readOnly")
        self.assertEqual(sent_messages[4]["method"], "thread/archive")
        self.assertEqual(output.modelMetadata.provider, "codex-app-server-agentic")

    def test_read_only_repository_turn_options_require_cwd(self) -> None:
        with self.assertRaisesRegex(ValueError, "repository cwd"):
            read_only_repository_turn_options(CodexAppServerConfig(command=("codex", "app-server"), model="test-model"))


def request():
    from review_worker.ports import ReviewRequest

    return ReviewRequest(context_bundle=context_bundle())


class FakeProcess:
    def __init__(self, messages):
        read_fd, write_fd = os.pipe()
        with os.fdopen(write_fd, "w", encoding="utf-8") as writer:
            for message in messages:
                writer.write(f"{json.dumps(message)}\n")
        self.stdout = os.fdopen(read_fd, "r", encoding="utf-8")
        self.stdin = CapturingStdin()
        self.stderr = StringIO("")
        self.terminated = False

    def poll(self):
        return None if not self.terminated else 0

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.terminated = True
        return 0

    def kill(self):
        self.terminated = True


class CapturingStdin:
    def __init__(self):
        self.lines = []

    def write(self, value):
        self.lines.append(value.strip())

    def flush(self):
        return None


if __name__ == "__main__":
    unittest.main()
