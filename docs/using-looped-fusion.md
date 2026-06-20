# Using Looped PI Fusion

Looped PI Fusion is the deliberation layer from
[`prd-pi-agent-fusion-loop.md`](prd-pi-agent-fusion-loop.md), now implemented. It sits
*before* the next move of an agent loop: instead of one model self-critiquing its own plan,
four role-specialized views (Explorer / Builder / Critic / Performance Sentinel) look at the
current run state, and a **Loop Conductor** turns their agreement and disagreement into one
machine-readable decision plus a single next prompt.

```
   /looped <objective>          (or: node src/cli.mjs looped …)
        │
        ├─ resolve model assignments (roster + role→model policy)
        ├─ Explorer        ─┐
        ├─ Builder          ─┤  four independent views via the `pi` backend
        ├─ Critic           ─┤  (uses your Pi subscriptions — no API keys)
        └─ Performance Sentinel ─┘
        │
        Loop Conductor: reads views + run-state snapshot
        │
        ├─ writes  loop-conductor-decision.json   (status, tensions, risk_flags, next_prompt, stop_condition…)
        ├─ writes  loop-conductor-prompt.md       (directly-usable next PI-agent prompt)
        ├─ writes  loop-conductor-summary.md      (human-readable)
        └─ writes  *-view.md + model-assignments.json
        │
        ▼
   the next prompt is injected into the session (or printed) for your brain model to act on
```

**V1 is a Prompt Driver only** (per the PRD's Non-Goals): it never edits files, runs tests,
or spawns arbitrary agents. It reads state, deliberates, and writes the next prompt. Existing
Pi primitives still own execution.

## Run it

### Inside Pi (recommended)

A `/looped` slash command is auto-loaded from `.pi/extensions/looped-fusion.ts`. Launch Pi
from this repo and run:

```
/looped Add a regression test for the looped-fusion config loader, then wire it into CI
```

The extension snapshots the current session (`ctx.sessionManager`) into the run state,
spawns one Loop Conductor round, writes artifacts under `runs/<id>/artifacts/pi-fusion/`, and
injects the conductor's decision + next prompt as a context message your brain model reasons
over. You decide whether to follow the next prompt.

### From the CLI

```bash
# Node — writes artifacts and prints the full result JSON:
node src/cli.mjs looped --config looped-fusion.config.json \
  --runDir ./runs/last --step 1 "<objective>"

# Python mirror (identical behaviour):
python3 -m local_fusion looped --config looped-fusion.config.json \
  --run-dir ./runs/last "<objective>"
```

## The decision contract

`loop-conductor-decision.json` (full schema in the PRD):

| Field | Meaning |
|-------|---------|
| `status` | `continue` \| `split` \| `pause_for_human` \| `possibly_stuck` \| `complete` |
| `consensus` | Points the views agreed on. |
| `tensions` | Where they disagreed, with each stance (the whole point of fusing). |
| `risk_flags` | Specific risks derived from the evidence. |
| `next_pi_agent` | The role best suited to act next. |
| `next_model_id` | The roster model id for that role (validated against the roster). |
| `next_prompt` | One concrete, directly-runnable prompt — objective, constraints, evidence, stop condition. |
| `evidence_required` | What the next agent must produce. |
| `stop_condition` | When the loop ends. |
| `handoff_reason` | One sentence on why this move. |

The parser is defensive: an unknown `status` defaults to `continue`, an unknown
`next_pi_agent` defaults to `Builder`, and an out-of-roster `next_model_id` is set to `null`
with a risk flag. A missing or empty `next_prompt` fails the round.

## The artifact trail

```
runs/<run-id>/
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

This is the audit trail. If a run drifts later, you can walk the artifacts back to the
decision where it went wrong — which view said what, which tension the Conductor chose to
resolve first, and why.

## Tuning the roster

`looped-fusion.config.json` declares which models exist (`model_roster`) and which role each
uses (`role_model_policy`, with `preferred` + `fallback_order`). The shipped config routes
every role through the `pi` backend using your subscriptions:

- Explorer / Performance Sentinel → GLM-5.2 (fast, free)
- Builder / Loop Conductor → GPT-5.4
- Critic → Kimi K2 Thinking

To use Opus, add it to the roster and point a role at it — note the Anthropic extra-usage
budget caveat (see the main `SKILL.md`). To mix in a local OpenAI-compatible model, give the
roster entry a non-`pi` transport (the looped runner reads `provider`/`modelId` from each
roster entry).

## Cost & latency

Every round is **5 model calls** (4 views + 1 conductor), all serialized through one Pi
subprocess. Expect ~1–3 minutes per round depending on the models and thinking levels. GLM
is free; GPT-5.4 and Kimi draw on your subscriptions.

## What this is not (yet)

- **Not an auto-loop.** `/looped` runs one round per invocation and hands the next prompt
  back. Auto-looping on every turn is a phase-2 feature.
- **Not an executor.** V1 never edits files or runs tests. It writes the next prompt; you
  and Pi's normal tools do the work.
- **Not a tool-calling agent backend.** The `pi` backend here is for deliberation, not for
  driving Pi's own model (the `serve` endpoint stays prose-only).

See [`prd-pi-agent-fusion-loop.md`](prd-pi-agent-fusion-loop.md) for the full spec and the
open questions deferred to later versions.
