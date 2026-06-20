---
name: local-fusion
description: Use when you want a multi-model "council" second opinion before committing to an answer, plan, design, or code direction. Trigger when the user says "ask the council", "fuse this", "fusion", "second opinion", "get multiple perspectives", "have the panel weigh in", "sanity-check this", "what would other models say", or when a decision is high-stakes or ambiguous and structured disagreement would help. It runs several LOCAL OpenAI-compatible models on the same prompt, has a judge produce structured comparison JSON (consensus, contradictions, blind spots), and a synthesizer write one final answer. Local-only — no cloud, no OpenRouter, nothing beyond localhost model servers. Do NOT use for trivial questions or when no local model server is running.
---

# local-fusion — local multi-model council (as a tool)

local-fusion sends one prompt to a **panel** of local models, has a **judge** compare
their answers as structured JSON, then a **synthesizer** writes a single final answer.
You invoke it through `bash`. It returns a synthesized answer plus a structured trace
of where the models agreed, disagreed, and what they missed.

This is a **tool you call**, not your model backend. Your own model still drives this
session — reach for local-fusion when a deliberated second opinion is worth ~20–40s.

> **Invoke it with the built-in `bash` tool. There is NO function or tool named
> `local-fusion`** — calling one will fail with "Tool local-fusion not found". To use the
> council you run the CLI below via `bash`, e.g. `bash → node src/cli.mjs ask "<question>"`,
> and read the answer from the command's stdout.

Repo root: `/Users/kelvincushman/dev/local-fusion` — run the commands below from there.

## Preconditions — check before real use

The shipped config drives models through a **Pi subprocess** (`backend: "pi"`), so the
only precondition is that Pi itself is installed and authenticated for the models in
`local-fusion.config.json`:

```bash
# 1. Pi is installed and on PATH.
command -v pi >/dev/null && pi --version || echo "pi not installed"

# 2. Pi is authed for the providers used in the config. This lists every model Pi
#    can currently reach (looks for glm-5.2 / gpt-5.4 / claude-opus-4-8):
pi --list-models 2>/dev/null | grep -Ei 'glm-5.2|gpt-5.4|claude-opus-4-8' || echo "a target model is not authed — run: pi /login"
```

If a precondition fails, tell the user how to fix it (install Pi, run `pi /login`,
or pick a different provider in the config). Don't invent auth silently.

> **Opus / Claude Pro-Max caveat:** Anthropic subscription access through a
> third-party harness (Pi) is billed per-token from your **extra usage** budget,
> *not* your plan limits. If Opus errors with `400 ... Add more at
> claude.ai/settings/usage`, the account has no/used-up extra-usage budget — the
> user must add it at claude.ai/settings/usage. GLM-5.2 (free) and GPT-5.4
> (ChatGPT sub) do not have this restriction.

## Backends

Each model entry picks a transport via its `backend` field:

- **`backend: "openai"`** (default, omit the field) — the original transport. local-fusion
  POSTs to an OpenAI-compatible `baseUrl` itself (`ollama`, LM Studio, llama.cpp, vLLM, …).
  Needs the server running; local-fusion carries its own `apiKey`/`apiKeyEnv`.
- **`backend: "pi"`** — local-fusion drives a headless Pi subprocess (`pi --mode rpc
  --no-session`) and uses Pi's stored auth, **including OAuth subscriptions**
  (ChatGPT/Claude Pro, ZAI). Requires `provider` + `modelId` instead of
  `baseUrl`/`apiKey`. No API keys of your own are needed — Pi owns all auth via
  `~/.pi/agent/auth.json`. One Pi subprocess is shared across the whole run
  (panel + judge + synth), so calls are serialized even with `parallel: true`.

The shipped `local-fusion.config.json` runs a three-model council via the `pi` backend:
GLM-5.2 (generalist) + GPT-5.4 (builder) + Opus (critic), Opus as judge, GPT-5.4 as synth.

## MCP connector for Claude Code / Opus executor workflows

For a Claude Code / Opus loop where Opus edits files and local-fusion checks the work, run
local-fusion as a dependency-free MCP stdio server:

```bash
node src/cli.mjs mcp --config local-fusion.config.json --rootDir ./runs/mcp
```

It exposes `fusion_ask`, `looped_start`, `looped_report`, `looped_check_work`,
`looped_fuse_review`, `looped_next`, and `looped_status`. The intended chain is:
Opus executes → `looped_report` → GPT checker gate → direct retry or conditional Fusion
review → Conductor `looped_next` → Opus executes again. See
[docs/using-mcp-connector.md](../docs/using-mcp-connector.md). MCP is pull-based: Claude
Code must call these tools; local-fusion cannot push into an already-running Claude Code
conversation.

## Looped PI Fusion (Prompt Driver)

For *deliberating the next move* of an agent loop (not just answering a question), use the
**Looped PI Fusion** layer (`src/looped.mjs` / `local_fusion/looped.py`, spec in
`docs/prd-pi-agent-fusion-loop.md`). One run dispatches four role-specialized views
(Explorer, Builder, Critic, Performance Sentinel), a **Loop Conductor** reads them plus a
run-state snapshot and emits a structured decision JSON (status, consensus, tensions, risk
flags, next_pi_agent, next_prompt, stop_condition), and writes a full artifact trail.

```bash
# From the CLI (one round, writes artifacts under <runDir>/artifacts/pi-fusion/):
node src/cli.mjs looped --config looped-fusion.config.json --runDir ./runs/last \
  --step 1 "<objective>"
python3 -m local_fusion looped --config looped-fusion.config.json --run-dir ./runs/last \
  "<objective>"

# From inside Pi: a /looped slash command is auto-loaded from .pi/extensions/looped-fusion.ts
# Usage:   /looped <objective>
```

The roster + role→model policy live in `looped-fusion.config.json`. V1 is a **Prompt Driver
only**: it never edits files or runs tests — it produces the next prompt and writes artifacts.
See [docs/using-looped-fusion.md](../docs/using-looped-fusion.md) for the full walkthrough.

## Commands

```bash
# Quick synthesized answer (prints the final answer to stdout):
node src/cli.mjs ask "Should we cache the judge output or recompute it each call?"

# Full trace — use this when you want the disagreement, not just the verdict:
node src/cli.mjs ask --json "Compare approach A vs B for X" > /tmp/fusion.json

# MCP connector for Claude Code / Opus executor workflows:
node src/cli.mjs mcp --config local-fusion.config.json --rootDir ./runs/mcp

# Long prompt via stdin:
echo "long multi-paragraph prompt..." | node src/cli.mjs ask --json

# Python implementation (identical behavior), if you prefer:
python3 -m local_fusion ask --json "..."
```

The `--json` result has this shape:

| Field | Meaning |
|-------|---------|
| `final_answer` | The synthesized answer. Lead with this. |
| `analysis.consensus` | Points most panel models agreed on. |
| `analysis.contradictions` | Where models disagreed, with each stance. |
| `analysis.blind_spots` | Important topics the panel missed. |
| `analysis.unique_insights` | Useful points only one model raised. |
| `responses` | Raw per-model answers (for provenance). |
| `failed_models` | Panel members that errored. |
| `degradation_reasons` | Non-empty ⇒ the run was degraded — treat consensus cautiously. |

Read a field quickly without dumping the whole blob:

```bash
node -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/fusion.json","utf8"));
console.log(r.final_answer); console.log("\nCONTRADICTIONS:", JSON.stringify(r.analysis.contradictions,null,2));'
```

## How to use the result

- Lead with `final_answer`.
- When robustness matters, surface `analysis.contradictions` and `analysis.blind_spots`
  to the user — that structured disagreement is the entire point of fusing.
- If `degradation_reasons` is non-empty, say so: some models failed or the judge fell
  back to a heuristic, so the consensus is weaker than it looks.

## When to use / when not to

- **Use** for design/plan reviews, ambiguous tradeoffs, "is this the right approach?",
  and surfacing blind spots before you commit.
- **Don't use** for trivial factual lookups or mechanical edits — it's several sequential
  local model calls, so it's slower and adds no value there.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| `Fusion needs a non-empty prompt.` | Empty prompt | Pass a real question. |
| `All panel models failed.` (status `error`) | No model reachable | For `backend: pi`: ensure `pi` is installed/authed (`pi --list-models`). For `backend: openai`: start the local server. |
| Opus error: `400 ... Add more at claude.ai/settings/usage` | Anthropic subscription has no/used-up **extra usage** budget (third-party harness calls are billed per-token, not against plan limits) | Add budget at claude.ai/settings/usage, or swap Opus for GPT-5.4/GLM/Kimi in the config. GLM (free), GPT-5.4 (ChatGPT sub), and Kimi K2 (Kimi Code sub) are unaffected. |
| `access_terminated_error` from a Kimi entry | Kimi Code is gated to approved coding-agent clients; a direct `backend: openai` call is rejected | Use `backend: "pi"` with `provider: "kimi-coding"` — only the Pi backend passes the gate. |
| `pi rpc <model> returned an error: ...` | The provider rejected the call (quota, model id, auth) | Read the message; fix auth (`pi /login`) or budget, or change the model. |
| `degradation_reasons` mentions the judge | Judge returned non-JSON | Answer is still usable; consensus is heuristic — flag it. |
| Call hangs then times out | Pi subprocess slow / cold model / long thinking | First call after cold load is slow; retry, or lower `timeoutMs`/pick a faster model in the config. |

## Tuning the council

The panel, judge, and synthesizer are defined in
`/Users/kelvincushman/dev/local-fusion/local-fusion.config.json`. The shipped config uses
the **`pi` backend** so the three models draw on your Pi subscriptions (no API keys needed).
Each entry needs `backend: "pi"`, `provider` (e.g. `zai`, `openai-codex`, `anthropic`),
and `modelId` (the exact id from `pi --list-models`). To mix in local OpenAI-compatible
models instead, give those entries `baseUrl`/`apiKey` (the default `openai` backend).
Keep in mind the `pi` backend serializes all calls through one Pi subprocess, so
`parallel: true` runs them back-to-back rather than concurrently.
