# PRD: Looped PI Fusion

## Summary

Looped PI Fusion adds a Fusion-style deliberation layer to PI agents. The goal is not to replace the PI loop. The goal is to make each loop step think with more than one perspective before it moves.

In v1, Looped PI Fusion is a Prompt Driver. PI agents produce independent views. The Loop Conductor reads those views, the run state, heartbeat data, and recent decisions, then emits the next loop-driving prompt. Existing PI primitives still own execution, worktrees, heartbeats, stuck detection, verification, handoff, and artifact recording.

## Problem

An autonomous agent loop can keep moving while becoming narrow. One agent can inspect, reason, act, verify, and record, but it can still overfit to its own framing. The failure mode is subtle: the loop is active, artifacts are written, and the next prompt sounds plausible, but the system has not really challenged its direction.

PI agents already solve the durability problem with run folders, heartbeats, progress logs, decisions, handoffs, and machine-readable state. Looped PI Fusion solves the deliberation problem by putting a structured multi-agent view step before the next prompt is created.

## Goals

- Add a PI-agent-native Fusion layer for independent agent views.
- Let PI choose multiple LLM models for different Fusion roles through a model roster and role policy.
- Target Fable 5-level outcomes on bounded builder workflows by combining role-specific PI agents, model routing, artifacts, and verification.
- Rename the "judge" role to **Loop Conductor**.
- Use the Loop Conductor to produce the next prompt/brief that drives the PI loop.
- Preserve PI's existing execution model and audit trail.
- Make every Fusion decision replayable from artifacts on disk.
- Keep v1 small enough to implement without turning the Loop Conductor into a full orchestrator.

## Non-Goals

- Do not make the Loop Conductor execute shell commands, edit files, or run tests in v1.
- Do not let the Loop Conductor directly spawn arbitrary agents in v1.
- Do not replace PI heartbeat, stuck detection, worktree isolation, verification, or handoff logic.
- Do not require OpenRouter, cloud routing, or hosted model infrastructure.
- Do not hardcode one model provider; local and remote OpenAI-compatible endpoints should both fit the roster.
- Do not treat "more agents" as automatically better; the value is structured disagreement before the next prompt.
- Do not claim universal Fable 5 parity. The target is Fable 5-level practical outcomes on scoped workflows, not benchmark equivalence across every task.

## Target User

The target user is a builder running PI agents as a local or personal agent harness. They want agent loops that can run longer than a single chat turn, leave evidence behind, recover after interruption, and produce better next-step prompts than a single model self-critiquing its own work.

## Outcome Thesis

Looped PI Fusion should let a builder get Fable 5-level results from the harness on narrow, evidence-rich workflows even when the individual models are mixed: local, remote, fast, specialized, or fallback. The quality lift comes from structured disagreement, role-specific model selection, artifact memory, and verification, not from pretending every model call is equally capable.

For v1, this means the success bar is practical: sharper next prompts, fewer narrow-loop failures, better test selection, clearer handoffs, and more auditable decisions.

## Core Concept

Looped PI Fusion inserts one step into the PI loop:

```text
inspect -> measure -> reason -> collect PI views -> Loop Conductor -> act -> verify -> heartbeat -> handoff
```

The Loop Conductor is not a judge in the courtroom sense. It does not just score outputs. It conducts the next movement of the loop:

- It finds consensus.
- It names tension.
- It marks risks.
- It chooses the next PI agent role.
- It writes the next prompt.
- It defines the stop condition for that next step.

## PI Agent Roles

V1 uses four default PI views.

### Explorer

Purpose: map current repo/state truth.

Expected output:

- relevant files, symbols, docs, or artifacts
- current implementation shape
- facts versus assumptions
- unknowns the next prompt must resolve

### Builder

Purpose: identify the practical implementation path.

Expected output:

- likely change shape
- smallest safe execution step
- dependencies and constraints
- implementation risks

### Critic

Purpose: challenge the direction before the loop commits to action.

Expected output:

- hidden assumptions
- likely failure modes
- missing tests or acceptance gaps
- reasons the next step may be wrong

### Performance Sentinel

Purpose: read loop health, timing, progress, and stuck signals.

Expected output:

- heartbeat status
- elapsed time versus expected time
- repeated-command or no-progress signs
- recommendation: healthy, slow, possibly_stuck, or needs_split

## Multi-LLM Model Selection in PI

PI should not treat "PI agent" and "LLM model" as the same thing. A PI agent is the role and artifact contract. An LLM model is the engine assigned to that role for a given run.

V1 uses a **model roster** plus a **role model policy**:

- `model_roster`: named LLM endpoints PI is allowed to use.
- `role_model_policy`: default model assignment for each PI view and for the Loop Conductor.
- `fallback_order`: ordered backup models when the preferred model is unavailable.
- `selection_reason`: recorded explanation for why PI chose a model for a role.

This lets one Looped PI Fusion run use several LLMs:

- Explorer: fast model with strong repo-search summarization.
- Builder: code-capable model.
- Critic: stronger reasoning model or stricter high-effort profile.
- Performance Sentinel: fast/cheap model, because it mostly reads heartbeat and logs.
- Loop Conductor: strongest synthesis model available.

The local `local-fusion` runner already supports this shape through its `panel`, `judge`, and `synthesizer` model config arrays. For PI, the same capability should be expressed as role-based assignments so the artifact trail says which model powered which PI view.

Example PI model policy:

```json
{
  "model_roster": {
    "fast-local": {
      "base_url": "http://localhost:11434/v1",
      "model": "qwen2.5:7b",
      "kind": "local",
      "best_for": ["exploration", "heartbeat", "summaries"]
    },
    "coder-local": {
      "base_url": "http://localhost:11434/v1",
      "model": "qwen2.5-coder:14b",
      "kind": "local",
      "best_for": ["implementation", "code-review"]
    },
    "reasoning-remote": {
      "base_url": "https://api.openai.com/v1",
      "model": "configured-strong-reasoner",
      "kind": "remote",
      "best_for": ["critique", "synthesis"]
    }
  },
  "role_model_policy": {
    "Explorer": {
      "preferred": "fast-local",
      "fallback_order": ["coder-local"]
    },
    "Builder": {
      "preferred": "coder-local",
      "fallback_order": ["reasoning-remote"]
    },
    "Critic": {
      "preferred": "reasoning-remote",
      "fallback_order": ["coder-local"]
    },
    "Performance Sentinel": {
      "preferred": "fast-local",
      "fallback_order": ["coder-local"]
    },
    "Loop Conductor": {
      "preferred": "reasoning-remote",
      "fallback_order": ["coder-local"]
    }
  }
}
```

PI writes the resolved model choices into the run artifacts before the views execute.

## Artifact Layout

Each Looped PI Fusion run writes into the current PI run folder:

```text
/docs/agent-runs/YYYY-MM-DD/YYYY-MM-DD-HH-MM-SS-topic/
  run.json
  heartbeat.json
    progress.log
    decisions.md
    handoff.md
    artifacts/
      pi-fusion/
        model-assignments.json
        explorer-view.md
        builder-view.md
        critic-view.md
        performance-sentinel-view.md
        loop-conductor-decision.json
        loop-conductor-prompt.md
        loop-conductor-summary.md
```

The view files are human-readable Markdown. The decision file is machine-readable JSON. The prompt file is the exact next prompt/brief that the PI loop should feed to the selected next agent.

`model-assignments.json` records the resolved model choices for the Fusion round:

```json
{
  "schema_version": "1.0",
  "assignments": [
    {
      "pi_agent": "Explorer",
      "model_id": "fast-local",
      "provider_kind": "local",
      "selection_reason": "Explorer needs quick repo/state summarization."
    },
    {
      "pi_agent": "Builder",
      "model_id": "coder-local",
      "provider_kind": "local",
      "selection_reason": "Builder needs code-oriented implementation reasoning."
    },
    {
      "pi_agent": "Critic",
      "model_id": "reasoning-remote",
      "provider_kind": "remote",
      "selection_reason": "Critic needs the strongest available adversarial reasoning."
    },
    {
      "pi_agent": "Performance Sentinel",
      "model_id": "fast-local",
      "provider_kind": "local",
      "selection_reason": "Performance Sentinel mostly reads heartbeat and progress state."
    },
    {
      "pi_agent": "Loop Conductor",
      "model_id": "reasoning-remote",
      "provider_kind": "remote",
      "selection_reason": "Loop Conductor needs the strongest synthesis model available."
    }
  ]
}
```

## Loop Conductor Input Contract

The Loop Conductor receives:

- original user/request objective
- current loop step
- `run.json`
- `heartbeat.json`
- recent `progress.log` entries
- recent `decisions.md` entries
- Explorer view
- Builder view
- Critic view
- Performance Sentinel view
- `model-assignments.json`
- optional previous `loop-conductor-decision.json`

The Loop Conductor must treat those inputs as evidence. It may infer, but it must separate inference from fact in the summary.

## Loop Conductor Output Contract

`loop-conductor-decision.json`:

```json
{
  "schema_version": "1.0",
  "run_id": "2026-06-15-21-30-00-looped-pi-fusion",
  "status": "continue",
  "consensus": [
    "The current task needs a focused implementation prompt rather than another broad exploration pass."
  ],
  "tensions": [
    {
      "topic": "test depth",
      "stances": [
        {
          "pi_agent": "Builder",
          "stance": "Run targeted tests only."
        },
        {
          "pi_agent": "Critic",
          "stance": "Add one regression test before implementation."
        }
      ]
    }
  ],
  "risk_flags": [
    "The heartbeat is healthy, but the last two attempts repeated the same failing command."
  ],
  "model_assignments": [
    {
      "pi_agent": "Explorer",
      "model_id": "fast-local"
    },
    {
      "pi_agent": "Builder",
      "model_id": "coder-local"
    },
    {
      "pi_agent": "Critic",
      "model_id": "reasoning-remote"
    },
    {
      "pi_agent": "Performance Sentinel",
      "model_id": "fast-local"
    },
    {
      "pi_agent": "Loop Conductor",
      "model_id": "reasoning-remote"
    }
  ],
  "next_pi_agent": "Builder",
  "next_model_id": "coder-local",
  "next_prompt": "Implement the smallest change that satisfies the acceptance criteria. Start by adding the missing regression test named by the Critic. Do not broaden scope. After editing, run the targeted test and update run artifacts.",
  "evidence_required": [
    "Updated regression test output",
    "Changed file summary",
    "Any unresolved errors"
  ],
  "stop_condition": "The targeted regression test passes and the Builder records changed files plus verification evidence.",
  "handoff_reason": "The views agree implementation is now safe, but the Critic's test concern must be addressed first."
}
```

Allowed `status` values:

- `continue`: produce a next prompt and keep the PI loop moving.
- `split`: task is too broad; next prompt must split the work.
- `pause_for_human`: missing authority or destructive branch.
- `possibly_stuck`: heartbeat/progress evidence indicates the loop is stuck.
- `complete`: stop condition appears satisfied; send to verifier or final handoff.

## Prompt File Contract

`loop-conductor-prompt.md` must be directly usable as the next PI-agent prompt. It should include:

- target PI agent role
- target model id when PI has resolved one
- objective
- exact constraints
- allowed files or artifact scope when known
- required evidence
- stop condition
- explicit non-goals

It must not include vague process filler such as "be careful" unless tied to a concrete instruction.

## Decision Rules

- Prefer the smallest next step that creates new evidence.
- If the Critic identifies an untested behavior risk, the next prompt must include a test or explicit reason not to test.
- If the Performance Sentinel marks `possibly_stuck`, the next prompt must narrow scope or hand off to performance recovery.
- If Explorer says the implementation surface is unknown, do not jump to Builder; send the next prompt back to Explorer.
- If Builder and Critic disagree, the Loop Conductor should preserve the disagreement in `tensions` and choose a next prompt that resolves it with evidence.
- If consensus exists but no stop condition is clear, the Loop Conductor must create one before continuing.
- If a preferred role model is unavailable, PI uses the role's `fallback_order`, records the fallback in `model-assignments.json`, and marks a `risk_flags` entry only when the fallback changes expected quality or capability.

## V1 Flow

1. PI loop starts or resumes a run folder.
2. Current agent records state in `run.json`, `heartbeat.json`, and progress artifacts.
3. PI resolves `model-assignments.json` from the model roster and role policy.
4. PI dispatches the four view agents or prompts:
   - Explorer
   - Builder
   - Critic
   - Performance Sentinel
5. Each view writes to `artifacts/pi-fusion/`.
6. Loop Conductor reads all views, model assignments, and state artifacts.
7. Loop Conductor writes:
   - `loop-conductor-decision.json`
   - `loop-conductor-prompt.md`
   - `loop-conductor-summary.md`
8. PI loop uses `next_pi_agent`, `next_model_id`, and `next_prompt` to continue.
9. Existing PI verification and heartbeat logic decides whether the run continues, splits, pauses, or completes.

## Error Handling

- Missing view file: mark a risk flag and proceed only if at least two views are present.
- Missing `heartbeat.json`: mark risk flag and route to Performance Sentinel unless the run is intentionally offline.
- Missing `model-assignments.json`: resolve it from the model roster before dispatching PI views.
- Preferred model unavailable: use role fallback order and record the fallback.
- Invalid decision JSON: do not continue automatically; route to Loop Conductor retry with stricter JSON-only instruction.
- Conflicting next agent names: choose only a known PI role and record the mismatch in `risk_flags`.
- No meaningful consensus: set `status` to `split` or route to Explorer/Critic for more evidence.

## Acceptance Criteria

- The PRD and blog use **PI agents** as the target implementation throughout.
- The role name is **Loop Conductor**, not judge, except when referencing OpenRouter Fusion's original terminology.
- V1 is clearly Prompt Driver only.
- The Loop Conductor output includes:
  - `consensus`
  - `tensions`
  - `risk_flags`
  - `model_assignments`
  - `next_pi_agent`
  - `next_model_id`
  - `next_prompt`
  - `evidence_required`
  - `stop_condition`
- Existing PI primitives remain responsible for execution.
- The PRD and blog frame Fable 5-level results as a bounded outcome target of the PI harness, not a universal benchmark-equivalence claim.
- A later implementation agent can build the feature from this PRD without choosing the schema, role names, or v1 boundaries.

## Open Questions for Later Versions

- Should Loop Conductor decisions be embedded in `run.json` or kept as a separate artifact only?
- Should PI support nested Fusion rounds for high-risk steps?
- Should the Performance Sentinel be mandatory for every loop, or only after a time threshold?
- Should Loop Conductor prompts be generated locally, remotely, or through a configurable model router?
