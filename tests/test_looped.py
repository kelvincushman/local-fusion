import json
import tempfile
import unittest
from pathlib import Path

from local_fusion.looped import (
    VIEW_ROLES,
    build_conductor_prompt,
    build_view_prompt,
    parse_decision,
    resolve_assignments,
    run_looped_fusion,
)

ROSTER = {
    "glm52": {"provider": "zai", "modelId": "glm-5.2", "kind": "local"},
    "gpt54": {"provider": "openai-codex", "modelId": "gpt-5.4", "kind": "remote"},
    "kimi": {"provider": "kimi-coding", "modelId": "kimi-k2-thinking", "kind": "local"},
}
POLICY = {
    "Explorer": {"preferred": "glm52", "fallback_order": ["kimi"], "reason": "fast"},
    "Builder": {"preferred": "gpt54", "fallback_order": ["kimi"], "reason": "coder"},
    "Critic": {"preferred": "kimi", "fallback_order": ["gpt54"], "reason": "adversarial"},
    "Performance Sentinel": {"preferred": "glm52", "fallback_order": ["kimi"], "reason": "cheap"},
    "Loop Conductor": {"preferred": "gpt54", "fallback_order": ["kimi"], "reason": "synthesis"},
}


def _decision_blob(**overrides):
    base = {
        "status": "continue",
        "next_pi_agent": "Builder",
        "next_model_id": "gpt54",
        "next_prompt": "do the thing",
        "evidence_required": ["out"],
        "stop_condition": "done",
        "handoff_reason": "because",
        "consensus": ["c"],
        "tensions": [],
        "risk_flags": [],
    }
    base.update(overrides)
    return json.dumps(base)


class ResolveAssignmentsTests(unittest.TestCase):
    def test_falls_back_when_preferred_missing(self):
        roster = {k: v for k, v in ROSTER.items() if k != "gpt54"}
        assignments = resolve_assignments(roster, POLICY)
        by_role = {a["pi_agent"]: a for a in assignments}
        self.assertEqual(by_role["Builder"]["model_id"], "kimi")
        self.assertTrue(by_role["Builder"].get("fallback"))
        self.assertEqual(by_role["Loop Conductor"]["model_id"], "kimi")
        self.assertEqual(len(assignments), 5)


class ParseDecisionTests(unittest.TestCase):
    def test_coerces_unknown_status_and_agent(self):
        assignments = resolve_assignments(ROSTER, POLICY)
        raw = _decision_blob(status="bogus", next_pi_agent="Wizard")
        ok, decision, notes, _ = parse_decision(raw, assignments, "run-1")
        self.assertTrue(ok)
        self.assertEqual(decision["status"], "continue")
        self.assertEqual(decision["next_pi_agent"], "Builder")
        self.assertGreaterEqual(len(notes), 2)

    def test_rejects_out_of_roster_next_model_id_as_risk(self):
        assignments = resolve_assignments(ROSTER, POLICY)
        raw = _decision_blob(next_model_id="claude-haiku-4-5")
        ok, decision, _notes, _ = parse_decision(raw, assignments, "run-1")
        self.assertTrue(ok)
        self.assertIsNone(decision["next_model_id"])
        self.assertTrue(any("claude-haiku-4-5" in r for r in decision["risk_flags"]))

    def test_fails_on_missing_next_prompt(self):
        assignments = resolve_assignments(ROSTER, POLICY)
        raw = json.dumps({"status": "continue", "next_pi_agent": "Builder", "next_model_id": "gpt54"})
        ok, _decision, _notes, _ = parse_decision(raw, assignments, "run-1")
        self.assertFalse(ok)


class RunLoopedFusionTests(unittest.TestCase):
    def _conductor_call(self, model_config, messages):
        if messages[0]["content"].startswith("You are the Loop Conductor"):
            return _decision_blob(
                next_pi_agent="Builder",
                next_model_id="gpt54",
                next_prompt="Implement X. Do not broaden scope.",
                evidence_required=["test output"],
                stop_condition="test passes",
                handoff_reason="surface is clear",
                consensus=["surface is clear"],
            )
        return f"view content from {model_config['name']}"

    def test_runs_four_views_and_writes_all_artifacts(self):
        with tempfile.TemporaryDirectory() as run_dir:
            result = run_looped_fusion(
                {"model_roster": ROSTER, "role_model_policy": POLICY},
                "objective",
                {"loopStep": 1},
                self._conductor_call,
                run_dir=run_dir,
            )
            self.assertEqual(result["status"], "ok")
            self.assertEqual(len(result["views"]), 4)
            self.assertEqual(sorted(v["role"] for v in result["views"]), sorted(VIEW_ROLES))
            self.assertEqual(result["decision"]["next_pi_agent"], "Builder")
            self.assertEqual(result["view_errors"], [])

            artifact_dir = Path(run_dir) / "artifacts" / "pi-fusion"
            expected = {
                "model-assignments.json",
                "explorer-view.md",
                "builder-view.md",
                "critic-view.md",
                "performance-sentinel-view.md",
                "loop-conductor-decision.json",
                "loop-conductor-prompt.md",
                "loop-conductor-summary.md",
            }
            self.assertEqual({p.name for p in artifact_dir.iterdir()}, expected)
            written = json.loads((artifact_dir / "loop-conductor-decision.json").read_text())
            self.assertEqual(written["next_prompt"], "Implement X. Do not broaden scope.")

    def test_aborts_when_fewer_than_two_views_succeed(self):
        def call(model_config, messages):
            raise RuntimeError("boom")

        result = run_looped_fusion(
            {"model_roster": ROSTER, "role_model_policy": POLICY},
            "objective",
            {"loopStep": 1},
            call,
            run_dir=None,
        )
        self.assertEqual(result["status"], "error")
        self.assertEqual(len(result["views"]), 0)
        self.assertIn("Aborted", result["summary"])


class PromptBuilderTests(unittest.TestCase):
    def test_build_view_prompt_embeds_objective_and_state(self):
        vp = build_view_prompt("Critic", "ship feature X", {"loopStep": 3, "heartbeat": "stale"})
        self.assertIn("ship feature X", vp)
        self.assertIn("3", vp)
        self.assertIn("stale", vp)

    def test_build_conductor_prompt_embeds_views_and_json_instruction(self):
        assignments = resolve_assignments(ROSTER, POLICY)
        cp = build_conductor_prompt("obj", {"loopStep": 1}, [{"role": "Critic", "content": "risky"}], assignments)
        self.assertIn("Return ONLY the JSON object", cp)
        self.assertIn("risky", cp)


if __name__ == "__main__":
    unittest.main()
