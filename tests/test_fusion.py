import json
import unittest

from local_fusion.core import parse_judge_analysis, run_fusion
from local_fusion.pi_transport import build_pi_prompt


class PiTransportTests(unittest.TestCase):
    def test_build_pi_prompt_prepends_preamble_system_and_user(self):
        prompt = build_pi_prompt(
            {"system": "You are a skeptical critic."},
            [
                {"role": "system", "content": "ignored-role-system"},
                {"role": "user", "content": "Compare A and B."},
                {"role": "user", "content": "Be brief."},
            ],
        )
        self.assertIn("Do NOT call any tools", prompt)
        self.assertIn("You are a skeptical critic.", prompt)
        self.assertIn("Compare A and B.\nBe brief.", prompt)
        self.assertNotIn("ignored-role-system", prompt)

    def test_run_fusion_routes_pi_models_through_injected_client(self):
        calls = []

        class FakePi:
            def __init__(self):
                self.close_calls = 0

            def ask(self, provider, model_id, prompt, timeout_ms):
                calls.append({"provider": provider, "modelId": model_id, "prompt": prompt})
                if model_id == "claude-opus-4-8":
                    return json.dumps(
                        {
                            "consensus": ["Both panel models agreed."],
                            "contradictions": [],
                            "partial_coverage": [],
                            "unique_insights": [],
                            "blind_spots": [],
                            "judge_notes": ["Prefer concrete steps."],
                        }
                    )
                if model_id == "gpt-5.4":
                    return "Fused via subscriptions"
                return f"answer from {model_id}"

            def close(self):
                self.close_calls += 1

        fake_pi = FakePi()
        result = run_fusion(make_pi_config(), "What should I build?", pi_client=fake_pi)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["final_answer"], "Fused via subscriptions")
        self.assertEqual(len(result["responses"]), 2)
        self.assertEqual(result["degradation_reasons"], [])
        self.assertEqual(len(calls), 4, "2 panel + judge + synth")
        self.assertEqual([c["provider"] for c in calls], ["zai", "openai-codex", "anthropic", "openai-codex"])
        self.assertEqual(fake_pi.close_calls, 0, "injected client is owned by the caller")


def make_pi_config():
    return {
        "parallel": False,
        "timeoutMs": 1000,
        "panel": [
            {"name": "glm52", "backend": "pi", "provider": "zai", "modelId": "glm-5.2", "system": "generalist"},
            {"name": "gpt54", "backend": "pi", "provider": "openai-codex", "modelId": "gpt-5.4", "system": "builder"},
        ],
        "judge": {"name": "judge", "backend": "pi", "provider": "anthropic", "modelId": "claude-opus-4-8"},
        "synthesizer": {"name": "synth", "backend": "pi", "provider": "openai-codex", "modelId": "gpt-5.4"},
    }


class FusionTests(unittest.TestCase):
    def test_parse_judge_analysis_extracts_fenced_json(self):
        analysis = parse_judge_analysis(
            """```json
{
  "consensus": ["A"],
  "contradictions": [],
  "partial_coverage": [],
  "unique_insights": [],
  "blind_spots": [],
  "judge_notes": ["Use A"]
}
```"""
        )

        self.assertEqual(analysis["consensus"], ["A"])
        self.assertEqual(analysis["judge_notes"], ["Use A"])

    def test_run_fusion_calls_panel_judge_and_synthesizer(self):
        calls = []

        def fake_chat(model_config, messages, timeout_ms):
            calls.append((model_config["name"], messages))
            return {
                "panel-a": "Use local model A.",
                "panel-b": "Use local model B.",
                "judge": json.dumps(
                    {
                        "consensus": ["Both mention local execution."],
                        "contradictions": [],
                        "partial_coverage": [],
                        "unique_insights": [{"model": "panel-a", "insight": "A is faster."}],
                        "blind_spots": [],
                        "judge_notes": ["Prefer concrete setup steps."],
                    }
                ),
                "synth": "Final fused answer",
            }[model_config["name"]]

        result = run_fusion(make_config(), "What should I build?", chat_fn=fake_chat)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["final_answer"], "Final fused answer")
        self.assertEqual(len(result["responses"]), 2)
        self.assertEqual(result["analysis"]["consensus"], ["Both mention local execution."])
        self.assertEqual(result["degradation_reasons"], [])
        self.assertEqual(len(calls), 4)

    def test_run_fusion_degrades_when_one_panel_model_fails(self):
        def fake_chat(model_config, messages, timeout_ms):
            if model_config["name"] == "panel-b":
                raise RuntimeError("boom")
            return {
                "panel-a": "Only model A answered.",
                "judge": json.dumps({key: [] for key in ("consensus", "contradictions", "partial_coverage", "unique_insights", "blind_spots", "judge_notes")}),
                "synth": "Final fused answer",
            }[model_config["name"]]

        result = run_fusion(make_config(), "Compare options", chat_fn=fake_chat)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["responses"]), 1)
        self.assertEqual(len(result["failed_models"]), 1)
        self.assertIn("Some panel models failed.", result["degradation_reasons"])
        self.assertEqual(result["final_answer"], "Final fused answer")

    def test_run_fusion_uses_heuristic_analysis_when_judge_json_is_invalid(self):
        def fake_chat(model_config, messages, timeout_ms):
            return {
                "panel-a": "Model A answer",
                "panel-b": "Model B answer",
                "judge": "not-json",
                "synth": "Final fused answer",
            }[model_config["name"]]

        result = run_fusion(make_config(), "Compare options", chat_fn=fake_chat)

        self.assertIn("Judge output was not valid JSON; used heuristic analysis.", result["degradation_reasons"])
        self.assertEqual(result["analysis"]["blind_spots"], ["No structured judge analysis was available."])

    def test_run_fusion_reports_error_when_all_panel_models_fail(self):
        def fake_chat(model_config, messages, timeout_ms):
            raise RuntimeError("failed")

        result = run_fusion(make_config(), "Compare options", chat_fn=fake_chat)

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["responses"], [])
        self.assertEqual(len(result["failed_models"]), 2)
        self.assertEqual(result["degradation_reasons"], ["All panel models failed."])


def make_config():
    return {
        "parallel": False,
        "timeoutMs": 1000,
        "panel": [
            {"name": "panel-a", "baseUrl": "http://panel-a.test/v1", "apiKey": "local", "model": "a"},
            {"name": "panel-b", "baseUrl": "http://panel-b.test/v1", "apiKey": "local", "model": "b"},
        ],
        "judge": {"name": "judge", "baseUrl": "http://judge.test/v1", "apiKey": "local", "model": "judge"},
        "synthesizer": {"name": "synth", "baseUrl": "http://synth.test/v1", "apiKey": "local", "model": "synth"},
    }


if __name__ == "__main__":
    unittest.main()
