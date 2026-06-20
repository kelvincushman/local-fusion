"""Looped PI Fusion — Prompt Driver layer over the agent loop (mirror of src/looped.mjs).

Implements docs/prd-pi-agent-fusion-loop.md. Per run:
  1. resolve model assignments for the 4 view roles + Conductor from a roster
  2. dispatch Explorer / Builder / Critic / Performance Sentinel views
     (each a single role-specialized council call via the existing transport)
  3. Loop Conductor reads views + run-state snapshot, emits decision JSON
  4. write the artifact trail under <run_dir>/artifacts/pi-fusion/
  5. return { decision, prompt, summary } for the caller to inject

V1 is a Prompt Driver only (per PRD Non-Goals): this module never executes
shell, edits files, or runs tests. It writes artifacts and produces a next
prompt. The agent loop owns execution.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from typing import Any

from .core import extract_json_payload  # exported via __init__

VIEW_ROLES = ["Explorer", "Builder", "Critic", "Performance Sentinel"]
ALL_ROLES = [*VIEW_ROLES, "Loop Conductor"]
VALID_STATUSES = ["continue", "split", "pause_for_human", "possibly_stuck", "complete"]

VIEW_SYSTEMS = {
    "Explorer": (
        "You are the Explorer in a PI Fusion loop. Map what is actually true on the ground: "
        "relevant files, symbols, docs, current shape, facts vs assumptions, unknowns the next "
        "prompt must resolve. Do not propose code."
    ),
    "Builder": (
        "You are the Builder in a PI Fusion loop. Identify the smallest safe implementation step: "
        "likely change shape, seams, what to touch, what not to touch, dependencies, implementation risks."
    ),
    "Critic": (
        "You are the Critic in a PI Fusion loop. Challenge the direction before the loop commits: "
        "hidden assumptions, likely failure modes, missing tests, reasons the next step may be wrong."
    ),
    "Performance Sentinel": (
        "You are the Performance Sentinel in a PI Fusion loop. Read loop health from the run-state "
        "snapshot: heartbeat freshness, elapsed vs expected time, repeated commands or no-progress, "
        "and recommend a health verdict: healthy | slow | possibly_stuck | needs_split."
    ),
}

CONDUCTOR_SYSTEM = (
    "You are the Loop Conductor of a PI agent Fusion loop. You do not execute. You read the run "
    "evidence and the four PI-agent views, then return ONLY a JSON object. The next PI-agent prompt "
    "depends on your output being machine-parseable JSON. No prose, no code fences, no commentary. "
    "Separate fact from inference in consensus and risk_flags."
)


def resolve_assignments(roster: dict[str, Any], policy: dict[str, Any]) -> list[dict[str, Any]]:
    assignments: list[dict[str, Any]] = []
    for role in ALL_ROLES:
        entry = (policy or {}).get(role, {})
        preferred = entry.get("preferred")
        fallback = entry.get("fallback_order") or []
        order = [preferred, *fallback]
        model_id = None
        used_fallback = False
        for candidate in order:
            if candidate and roster and candidate in roster:
                model_id = candidate
                if candidate != preferred:
                    used_fallback = True
                break
        assignment: dict[str, Any] = {
            "pi_agent": role,
            "model_id": model_id,
            "provider_kind": (roster.get(model_id, {}).get("kind") if model_id and roster else "unresolved"),
            "selection_reason": entry.get("reason") or f"Default assignment for {role}.",
        }
        if used_fallback:
            assignment["fallback"] = True
        assignments.append(assignment)
    return assignments


def build_view_prompt(role: str, objective: str, run_state: dict[str, Any]) -> str:
    return (
        f"Run objective: {objective}\n\n"
        f"Current loop step: {run_state.get('loopStep', 1)}.\n\n"
        "Run-state snapshot (evidence — treat as ground truth; cite where relevant):\n"
        f"{format_run_state(run_state)}\n\n"
        f"Produce only your {role} view. Be specific and brief. Cite concrete file names, "
        "commands, or timings from the snapshot where you can. Do not role-play the other views."
    )


def build_conductor_prompt(
    objective: str,
    run_state: dict[str, Any],
    views: list[dict[str, str]],
    assignments: list[dict[str, Any]],
) -> str:
    schema = json.dumps(
        {
            "schema_version": "1.0",
            "status": "continue | split | pause_for_human | possibly_stuck | complete",
            "consensus": ["short points the views agree on"],
            "tensions": [
                {
                    "topic": "short",
                    "stances": [
                        {"pi_agent": "Explorer|Builder|Critic|Performance Sentinel", "stance": "..."}
                    ],
                }
            ],
            "risk_flags": ["specific risks derived from the evidence; empty array if none"],
            "next_pi_agent": "Explorer | Builder | Critic | Performance Sentinel",
            "next_model_id": "the roster model id best suited to execute next_prompt",
            "next_prompt": (
                "a single concrete, directly-runnable PI-agent prompt: objective, constraints, "
                "allowed scope, required evidence, stop condition. No filler."
            ),
            "evidence_required": ["specific artifacts the next agent must produce"],
            "stop_condition": "a concrete, testable condition that ends the loop",
            "handoff_reason": "one sentence: why this next move",
        },
        indent=2,
    )
    parts = [
        f"Run objective: {objective}",
        "",
        f"Current loop step: {run_state.get('loopStep', 1)}.",
        "",
        "Model assignments (these are the roster model ids available; next_model_id MUST be one of them or null):",
        json.dumps([{"pi_agent": a["pi_agent"], "model_id": a["model_id"]} for a in assignments], indent=2),
        "",
        "Run-state snapshot (evidence):",
        format_run_state(run_state),
        "",
        "PI-agent views:",
        *[f"### {v['role']}\n{v['content']}" for v in views],
        "",
        "Decision rules:",
        "- Prefer the smallest next step that creates new evidence.",
        "- If the Critic flags an untested behaviour risk, next_prompt must include a test or an explicit reason not to test.",
        "- If Performance Sentinel marks possibly_stuck, next_prompt must narrow scope.",
        "- If Explorer says the surface is unknown, do not jump to Builder; route back to Explorer.",
        "- Preserve Builder/Critic disagreement in tensions and choose a next prompt that resolves it with evidence.",
        "- If consensus exists but no stop condition is clear, create one before continuing.",
        "",
        "Return ONLY the JSON object. Schema (exact keys):",
        schema,
    ]
    return "\n".join(parts)


def parse_decision(
    raw_output: str, assignments: list[dict[str, Any]], run_id: str
) -> tuple[bool, dict[str, Any] | None, list[str], str]:
    """Return (ok, decision_or_none, parser_notes, raw_output)."""
    payload = extract_json_payload(raw_output)
    try:
        parsed = json.loads(payload)
    except Exception:
        return False, None, [], raw_output

    valid_model_ids = {a["model_id"] for a in assignments if a.get("model_id")}
    notes: list[str] = []

    status = parsed.get("status")
    if status not in VALID_STATUSES:
        notes.append(f'Conductor returned invalid status "{status}"; defaulted to continue.')
        status = "continue"

    next_agent = parsed.get("next_pi_agent")
    if next_agent not in VIEW_ROLES:
        notes.append(f'Conductor returned unknown next_pi_agent "{next_agent}"; defaulted to Builder.')
        next_agent = "Builder"

    next_model_id = parsed.get("next_model_id")
    risk_flags = parsed.get("risk_flags") if isinstance(parsed.get("risk_flags"), list) else []
    if next_model_id and next_model_id not in valid_model_ids:
        risk_flags = [*risk_flags, f'Conductor proposed next_model_id "{next_model_id}" which is not in the resolved roster; set to null.']
        next_model_id = None

    next_prompt = parsed.get("next_prompt")
    if not isinstance(next_prompt, str) or not next_prompt.strip():
        return False, None, notes, raw_output

    decision = {
        "schema_version": "1.0",
        "run_id": run_id,
        "status": status,
        "consensus": parsed.get("consensus") if isinstance(parsed.get("consensus"), list) else [],
        "tensions": parsed.get("tensions") if isinstance(parsed.get("tensions"), list) else [],
        "risk_flags": risk_flags,
        "model_assignments": [{"pi_agent": a["pi_agent"], "model_id": a["model_id"]} for a in assignments],
        "next_pi_agent": next_agent,
        "next_model_id": next_model_id,
        "next_prompt": next_prompt.strip(),
        "evidence_required": parsed.get("evidence_required") if isinstance(parsed.get("evidence_required"), list) else [],
        "stop_condition": (parsed.get("stop_condition") or "").strip() if isinstance(parsed.get("stop_condition"), str) else "",
        "handoff_reason": (parsed.get("handoff_reason") or "").strip() if isinstance(parsed.get("handoff_reason"), str) else "",
    }
    return True, decision, notes, raw_output


def run_looped_fusion(
    config: dict[str, Any],
    objective: str,
    run_state: dict[str, Any],
    call: Any,
    *,
    run_id: str | None = None,
    run_dir: str | None = None,
) -> dict[str, Any]:
    run_id = run_id or _make_run_id()
    roster = config.get("model_roster")
    policy = config.get("role_model_policy")
    assignments = resolve_assignments(roster, policy)

    def model_for(role: str) -> dict[str, Any]:
        for a in assignments:
            if a["pi_agent"] == role:
                if not a["model_id"]:
                    raise ValueError(f"No model assigned for role {role} (roster/policy incomplete).")
                return _model_config_from_roster(roster, a["model_id"])
        raise ValueError(f"No assignment for role {role}.")

    views: list[dict[str, str]] = []
    view_errors: list[dict[str, str]] = []

    def run_view(role: str) -> None:
        try:
            content = call(
                model_for(role),
                [
                    {"role": "system", "content": VIEW_SYSTEMS[role]},
                    {"role": "user", "content": build_view_prompt(role, objective, run_state)},
                ],
            )
            views.append({"role": role, "content": str(content or "").strip()})
        except Exception as error:  # noqa: BLE001
            view_errors.append({"role": role, "error": str(error)})

    for role in VIEW_ROLES:
        run_view(role)

    if len(views) < 2:
        return {
            "status": "error",
            "run_id": run_id,
            "decision": None,
            "prompt": "",
            "summary": f"Aborted: only {len(views)}/4 views succeeded ({', '.join(e['role'] for e in view_errors) or 'none'}).",
            "views": views,
            "view_errors": view_errors,
            "assignments": assignments,
        }

    try:
        conductor_raw = call(
            model_for("Loop Conductor"),
            [
                {"role": "system", "content": CONDUCTOR_SYSTEM},
                {"role": "user", "content": build_conductor_prompt(objective, run_state, views, assignments)},
            ],
        )
        ok, decision, notes, raw_output = parse_decision(conductor_raw, assignments, run_id)
    except Exception as error:  # noqa: BLE001
        return {
            "status": "error",
            "run_id": run_id,
            "decision": None,
            "prompt": "",
            "summary": f"Conductor call failed: {error}.",
            "views": views,
            "view_errors": view_errors,
            "assignments": assignments,
        }

    if not ok:
        return {
            "status": "error",
            "run_id": run_id,
            "decision": None,
            "prompt": "",
            "summary": notes and "Loop Conductor output was not valid JSON." or "Loop Conductor returned no usable next_prompt.",
            "views": views,
            "view_errors": view_errors,
            "assignments": assignments,
            "raw_conductor_output": raw_output or None,
        }

    assert decision is not None
    prompt = render_prompt_file(decision, objective)
    summary = render_summary(decision, views, view_errors, notes)

    if run_dir:
        write_artifacts(run_dir, run_id, objective, run_state, assignments, views, view_errors, decision, prompt, summary)

    return {
        "status": "ok",
        "run_id": run_id,
        "decision": decision,
        "prompt": prompt,
        "summary": summary,
        "views": views,
        "view_errors": view_errors,
        "assignments": assignments,
        "conductor_notes": notes,
    }


def write_artifacts(
    run_dir: str,
    run_id: str,
    objective: str,
    run_state: dict[str, Any],
    assignments: list[dict[str, Any]],
    views: list[dict[str, str]],
    view_errors: list[dict[str, str]],
    decision: dict[str, Any],
    prompt: str,
    summary: str,
) -> None:
    base = os.path.join(run_dir, "artifacts", "pi-fusion")
    os.makedirs(base, exist_ok=True)
    _write(base, "model-assignments.json", json.dumps({"schema_version": "1.0", "assignments": assignments}, indent=2))
    for view in views:
        _write(base, f"{_kebab(view['role'])}-view.md", view["content"])
    _write(base, "loop-conductor-decision.json", json.dumps(decision, indent=2))
    _write(base, "loop-conductor-prompt.md", prompt)
    _write(base, "loop-conductor-summary.md", summary)


def render_prompt_file(decision: dict[str, Any], objective: str) -> str:
    lines = [
        f"# Loop Conductor prompt — {decision['run_id']}",
        "",
        f"- Target PI agent: **{decision['next_pi_agent']}**",
        f"- Target model: `{decision['next_model_id']}`" if decision.get("next_model_id") else "- Target model: _unset_",
        f"- Objective: {objective}",
        "",
        "## Next prompt",
        "",
        decision.get("next_prompt") or "_(empty)_",
        "",
        "## Required evidence",
    ]
    lines += [f"- {e}" for e in decision.get("evidence_required", [])] or ["- _(none specified)_"]
    lines += ["", "## Stop condition", "", decision.get("stop_condition") or "_(unspecified)_"]
    return "\n".join(lines)


def render_summary(decision: dict[str, Any], views: list[dict[str, str]], view_errors: list[dict[str, str]], notes: list[str]) -> str:
    next_model = f" ({decision['next_model_id']})" if decision.get("next_model_id") else ""
    lines = [
        f"# Loop Conductor summary — {decision['run_id']}",
        "",
        f"**Status:** {decision['status']}  |  **Next:** {decision['next_pi_agent']}{next_model}",
        "",
        f"**Handoff reason:** {decision.get('handoff_reason') or '_(none)_'}",
        "",
        "## Consensus",
    ]
    lines += [f"- {c}" for c in decision.get("consensus", [])] or ["- _(none)_"]
    lines += ["", "## Tensions"]
    if decision.get("tensions"):
        for t in decision["tensions"]:
            stances = " / ".join(f"{s.get('pi_agent')}: {s.get('stance')}" for s in (t.get("stances") or []))
            lines.append(f"- **{t.get('topic') or 'unnamed'}** — {stances}")
    else:
        lines.append("- _(none)_")
    lines += ["", "## Risk flags"]
    lines += [f"- {r}" for r in decision.get("risk_flags", [])] or ["- _(none)_"]
    present = ", ".join(v["role"] for v in views) or "none"
    failed = f"  |  failed: {', '.join(e['role'] for e in view_errors)}" if view_errors else ""
    lines += ["", f"## Views present: {present}{failed}"]
    if notes:
        lines += ["", "## Parser notes", *[f"- {n}" for n in notes]]
    return "\n".join(lines)


def format_run_state(run_state: dict[str, Any]) -> str:
    if not run_state or not any(run_state.values()):
        return "_(no run-state provided)_"
    lines: list[str] = []

    def push(label: str, value: Any) -> None:
        if value not in (None, "", []):
            lines.append(f"- {label}: {value}")

    push("Loop step", run_state.get("loopStep"))
    push("Heartbeat", run_state.get("heartbeat"))
    push("Elapsed", run_state.get("elapsed"))
    push("Expected", run_state.get("expected"))
    push("Health verdict", run_state.get("health"))
    recent_cmds = run_state.get("recentCommands") or []
    if recent_cmds:
        lines.append("- Recent commands:")
        for cmd in recent_cmds[-8:]:
            lines.append(f"    - {cmd}")
    recent_msgs = run_state.get("recentMessages") or []
    if recent_msgs:
        lines.append("- Recent agent activity:")
        for msg in recent_msgs[-8:]:
            lines.append(f"    - {msg}")
    if run_state.get("notes"):
        lines.append(f"- Notes: {run_state['notes']}")
    return "\n".join(lines) if lines else "_(empty run-state)_"


def _model_config_from_roster(roster: dict[str, Any], model_id: str) -> dict[str, Any]:
    entry = (roster or {}).get(model_id)
    if not entry:
        raise ValueError(f'Model "{model_id}" not found in roster.')
    return {
        "backend": "pi",
        "name": model_id,
        "provider": entry["provider"],
        "modelId": entry.get("modelId") or entry.get("model") or model_id,
        "system": "",
    }


def _make_run_id() -> str:
    d = datetime.now()
    return d.strftime("%Y-%m-%d-%H-%M-%S") + "-looped-pi-fusion"


def _kebab(value: str) -> str:
    return re.sub(r"\s+", "-", value.strip().lower())


def _write(base: str, name: str, body: str) -> None:
    with open(os.path.join(base, name), "w", encoding="utf-8") as f:
        f.write(body)
