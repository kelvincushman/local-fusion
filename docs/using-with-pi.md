# Using local-fusion inside a Pi agent

This wires `local-fusion` into [Pi](https://github.com/badlogic/pi) (`@mariozechner/pi-coding-agent`)
as a **tool the agent can consult** — not as Pi's model backend. You run Pi with your normal
brain model; when a decision is ambiguous or high-stakes, the agent calls the local-fusion
council for a deliberated, multi-perspective second opinion.

```
        you ──▶ Pi (your brain model, drives the session, uses tools)
                  │  bash: node src/cli.mjs ask --json "..."
                  ▼
            local-fusion  ──▶  panel models  ─┐
                          ──▶  judge (JSON)   ─┤  all on local OpenAI-compatible servers
                          ──▶  synthesizer    ─┘
                  │  final_answer + analysis (consensus / contradictions / blind spots)
                  ▼
            back to Pi, which folds it into its reply
```

## Why a tool and not Pi's model backend

Pi is a coding agent: it needs tool-calling and streaming from its model. local-fusion's
`serve` endpoint is **prose-only** — it ignores the `tools` field and never streams — so it
can't drive Pi's edit/bash loop. As a *tool*, though, it's a perfect fit: it just takes a
prompt and returns a synthesized answer, which is exactly what a tool result should be. (Making
the council a true model backend, or building the full "Looped PI Fusion" loop from
[`prd-pi-agent-fusion-loop.md`](prd-pi-agent-fusion-loop.md), are larger follow-on projects —
see the bottom of this doc.)

## What was added

| File | Purpose |
|------|---------|
| `.pi/skills/local-fusion/SKILL.md` | The Pi skill. Pi auto-discovers it when run from this repo and loads it on demand when a turn matches the description. |
| `AGENTS.md` | Always-loaded project context: what the repo is, the dev/test workflow, and that the council is available as a tool. |
| `local-fusion.config.json` | A working runtime config pointing at your live ollama `gemma3` server (three role-prompted panel members + judge + synthesizer). |

Nothing in your global Pi setup (`~/.pi/agent/`) was changed — your default brain model and
auth are untouched.

## Prerequisites

- **Pi** ≥ 0.76 (`pi --version`) and **Node** ≥ 20 (`node --version`). Both already present.
- **A local OpenAI-compatible model server running.** The shipped config uses ollama:
  ```bash
  ollama serve            # if not already running (the desktop app starts it too)
  ollama list             # should show gemma3:latest
  ```
  Verified working: `curl -s http://localhost:11434/v1/models`.

## Run it

From the repo root:

```bash
cd /Users/kelvincushman/dev/local-fusion
pi
```

Then ask for a council opinion in natural language — Pi will load the skill and run it:

> "Get a local-fusion council second opinion on whether to memoize the judge call. Show me where the models disagree."

Or one-shot, without the TUI:

```bash
pi -p "Use the local-fusion council to pressure-test this plan: <paste plan>. Surface blind spots."
```

You can also call the council directly, no Pi involved:

```bash
node src/cli.mjs ask "Compare ridge vs lasso regression. Where does each shine?"
node src/cli.mjs ask --json "Design a local-first writing assistant" | node -e \
  'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.final_answer)'
```

## A note on your brain model

Your Pi default is the local MLX model (`omlx` / `gemma-4-E2B…`). That works, but the brain's
main job here is *judging when a council opinion is worth fetching and how to fold it in* — a
stronger brain does that better. To try a stronger one for a session (no permanent change):

```bash
pi --model anthropic/claude-sonnet-4-6     # needs `pi /login` once
# or a larger local model you have pulled
```

The council itself is independent of the brain — it always runs whatever is in
`local-fusion.config.json`.

## Making the council stronger

The default config runs **one** model (`gemma3`) under three different role prompts. That adds
test-time deliberation but not true model diversity. For a sharper council, add panel members
from *different* model families / servers in `local-fusion.config.json` and flip
`"parallel": true` (safe once each model is on its own server):

```jsonc
// extra panel entries, for example:
{ "name": "lmstudio-generalist", "baseUrl": "http://localhost:1234/v1", "apiKey": "lm-studio", "model": "local-model", ... }
{ "name": "llamacpp-skeptic",    "baseUrl": "http://localhost:8080/v1", "apiKey": "llama.cpp", "model": "local-model", ... }
```

Best results come from genuine diversity plus a strict judge.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pi doesn't load the skill | Make sure you launched `pi` from inside this repo (skills are discovered from `.pi/skills/` in cwd). Ask more explicitly: "use the local-fusion skill". |
| `All panel models failed` | No model server reachable — start ollama and re-check `baseUrl`s in the config. |
| First call is very slow | Cold model load. The next call is faster; or lower `maxTokens` in the config. |
| Want the raw disagreement | Use the `--json` form and read `analysis.contradictions` / `analysis.blind_spots`. |

## Where this can go next (not built)

- **Council as Pi's model backend (Option B).** Would require adding `tools`/`tool_calls`
  passthrough and SSE streaming to `serve`, plus a design for how a panel emits a single
  coherent tool call. Real engineering + an open design question.
- **Looped PI Fusion (Option C).** The full feature in
  [`prd-pi-agent-fusion-loop.md`](prd-pi-agent-fusion-loop.md): a Loop Conductor plus
  Explorer / Builder / Critic / Performance-Sentinel roles writing an on-disk artifact trail.
  A multi-session build.
