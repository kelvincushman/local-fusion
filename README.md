# local-fusion

[![CI](https://github.com/kelvincushman/local-fusion/actions/workflows/ci.yml/badge.svg)](https://github.com/kelvincushman/local-fusion/actions/workflows/ci.yml)

> Run an [OpenRouter **Fusion**](https://openrouter.ai/docs/guides/routing/routers/fusion-router)-style multi-model council **locally** — no OpenRouter, no hosted router, no billing middleman.

`local-fusion` sends one prompt to a panel of models, has a **judge** model compare their answers into structured analysis, then has a **synthesizer** model write the final answer. It runs against any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, MLX, LocalAI, …) **and/or** against the subscription models you have configured in [Pi](https://github.com/badlogic/pi) (ChatGPT, Claude, GLM/ZAI, Kimi) — without you holding any API keys.

It ships four runtimes from one small, dependency-free codebase:

| Runtime | Command | What it is |
|---|---|---|
| **One-shot council** | `ask` | Panel → judge → synthesizer, returns a final answer (+ optional full trace). |
| **OpenAI-compatible server** | `serve` | Exposes the council at `POST /v1/chat/completions` so any OpenAI client can call it. |
| **Looped PI Fusion** | `looped` | A *prompt driver*: four role-views + a conductor read run state and emit the next agent prompt. |
| **MCP server** | `mcp` | Exposes the council and a build/check loop as tools to Claude Code / any MCP client. |

There is a **Node.js** implementation (`src/`, zero dependencies) and a parallel **Python** implementation (`local_fusion/`) with matching core behavior.

---

## Table of contents

- [Why](#why)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Backends: local OpenAI vs Pi subscriptions](#backends-local-openai-vs-pi-subscriptions)
- [Commands](#commands)
  - [`ask` — one-shot council](#ask--one-shot-council)
  - [`serve` — OpenAI-compatible endpoint](#serve--openai-compatible-endpoint)
  - [`looped` — Looped PI Fusion](#looped--looped-pi-fusion)
  - [`mcp` — MCP server for Claude Code](#mcp--mcp-server-for-claude-code)
- [Using inside a Pi agent](#using-inside-a-pi-agent)
- [Python implementation](#python-implementation)
- [Output schema](#output-schema)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [License](#license)

---

## Why

OpenRouter's Fusion router has five useful ideas. `local-fusion` recreates all of them with no hosted dependency:

1. A **panel** of configurable models answers the same prompt.
2. Panel calls run **in parallel** when the runtimes can handle it.
3. A **judge** *compares* the answers instead of naively merging them.
4. The judge returns **structured analysis**: consensus, contradictions, partial coverage, unique insights, blind spots, notes.
5. A **synthesizer** writes the final answer from the raw responses **plus** the judge analysis.

The payoff is diversity plus a strict judge. Best results come from genuinely different model families; fusing one model under different "perspective" system prompts still helps, but that is mostly extra test-time compute rather than true diversity.

What it deliberately does **not** do: OpenRouter, web search, web fetch, hosted routing, or your-own-API-key billing.

## How it works

```
                    ┌──────────────────────────── panel (parallel or sequential) ───────────────────────────┐
   prompt  ───────► │  model A (perspective 1)     model B (perspective 2)     model C (perspective 3)  ...   │
                    └───────────────────────────────────────────────┬──────────────────────────────────────┘
                                                                     │ raw independent answers
                                                                     ▼
                                                           ┌──────── judge ────────┐
                                                           │ strict JSON analysis:  │
                                                           │  consensus / contradic │
                                                           │  partial / unique /    │
                                                           │  blind spots / notes   │
                                                           └───────────┬───────────┘
                                                                       │ analysis + raw answers
                                                                       ▼
                                                        ┌──────── synthesizer ────────┐
                                                        │  one final answer, resolving │
                                                        │  contradictions explicitly   │
                                                        └───────────┬─────────────────┘
                                                                    ▼
                                              final_answer  (+ full trace via --json / structuredContent)
```

The harness is **degradation-tolerant**:

- If **some** panel models fail, it proceeds with the survivors and records `degradation_reasons`.
- If **all** panel models fail, it returns `status: "error"` with an empty answer.
- If the **judge** returns non-JSON, it falls back to a heuristic analysis and notes the degradation.
- If the **synthesizer** fails, it returns the first panel answer rather than nothing.

## Requirements

- **Node.js ≥ 20** (the Node runtime is dependency-free — nothing to `npm install`).
- **Python 3.10+** — only if you use the Python implementation.
- At least one model source:
  - One or more **local OpenAI-compatible servers** exposing `/v1/chat/completions`, **and/or**
  - **[Pi](https://github.com/badlogic/pi)** installed and authenticated, to use subscription/OAuth models.

Known-compatible local servers:

| Server | Typical base URL |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp server | `http://localhost:8080/v1` |
| vLLM / MLX / LocalAI | per their docs |

## Install

```sh
git clone https://github.com/kelvincushman/local-fusion.git
cd local-fusion

# Node runtime needs nothing installed. Verify it runs:
node src/cli.mjs --help

# Optional: link the `local-fusion` bin onto your PATH
npm link            # then: local-fusion ask "..."
```

## Quick start

### A) Local models (Ollama example)

```sh
ollama pull qwen2.5-coder:14b
ollama serve

cp config.example.json local-fusion.config.json   # then edit baseUrl/model to match your servers
node src/cli.mjs ask --config local-fusion.config.json "Compare ridge, lasso, and elastic-net regression. Where does each shine?"
```

> ⚠️ The committed `local-fusion.config.json` is configured for the **Pi backend** (subscription models). For pure local servers, base your config on `config.example.json` instead.

### B) Subscription models via Pi (no API keys of your own)

```sh
# Pi owns auth; log in once to the providers you want
pi /login

# The shipped config runs GLM-5.2 + GPT-5.4 + Kimi K2 this way
node src/cli.mjs ask "Design a local-first AI writing assistant architecture"
```

Print the full trace as JSON:

```sh
node src/cli.mjs ask --json "Design a local-first AI writing assistant architecture"
```

Pipe a prompt from stdin:

```sh
pbpaste | node src/cli.mjs ask --json
```

## Configuration reference

Config is a single JSON file (default `local-fusion.config.json`, override with `--config`). Paths are resolved relative to your current working directory.

### Top-level options

| Key | Type | Default | Meaning |
|---|---|---|---|
| `parallel` | boolean | `true` | Run panel calls concurrently. Set `false` if your machine can't hold several models at once. **All `pi`-backend calls are serialized through one subprocess regardless.** |
| `timeoutMs` | number | — | Per-call timeout in milliseconds. |
| `panel` | array | — | Model configs for the independent first-pass answers (≥ 1 required). |
| `judge` | object | — | Model config for the structured comparison JSON (required). |
| `synthesizer` | object | falls back to `judge` | Model config for final synthesis. |
| `model_roster` / `role_model_policy` | objects | — | **Only for `looped`** — see [Looped PI Fusion](#looped--looped-pi-fusion). |

### Per-model config

| Key | Applies to | Meaning |
|---|---|---|
| `name` | all | Readable name shown in the trace. |
| `backend` | all | `"openai"` (default) POSTs to `baseUrl`; `"pi"` drives a headless Pi subprocess. |
| `baseUrl` | `openai` | OpenAI-compatible base URL ending in `/v1`. |
| `apiKey` | `openai` | Dummy value is fine for local servers that ignore auth. |
| `apiKeyEnv` | `openai` | Name of an env var to read the key from instead of inlining it. |
| `model` | `openai` | Model name the server expects. |
| `provider` / `modelId` | `pi` | Pi provider + model id (e.g. `zai`/`glm-5.2`, `openai-codex`/`gpt-5.4`, `anthropic`/`claude-opus-4-8`, `kimi-coding`/`kimi-k2-thinking`). Discover with `pi --list-models`. |
| `temperature` | `openai` | Sampling temperature. (Ignored for `pi`.) |
| `maxTokens` | `openai` | Max response tokens. (Ignored for `pi`.) |
| `system` | all | Role/perspective system prompt — this is what shapes each panel member. |

### Example: pure local servers

See [`config.example.json`](config.example.json) — three local panel members (coder / generalist / skeptic), a strict judge, and a synthesizer, all pointed at Ollama / LM Studio / llama.cpp.

### Example: Pi subscription council

See [`local-fusion.config.json`](local-fusion.config.json) — GLM-5.2 (generalist) + GPT-5.4 (builder) + Kimi K2 (critic) panel, Kimi K2 judge, GPT-5.4 synthesizer.

## Backends: local OpenAI vs Pi subscriptions

`local-fusion` mixes two backends freely — even within a single panel.

**`backend: "openai"` (default).** A plain HTTP POST to `baseUrl/chat/completions`. Use for Ollama, LM Studio, llama.cpp, vLLM, MLX, LocalAI, or any OpenAI-compatible endpoint.

**`backend: "pi"`.** Spawns a headless `pi` subprocess and uses **Pi's stored auth** (`~/.pi/agent/auth.json`), including OAuth subscriptions (ChatGPT Plus/Pro, Claude Pro/Max) and ZAI/Kimi. `local-fusion` holds **no API keys of its own**. Use `provider` + `modelId` instead of `baseUrl`/`apiKey`. All `pi` calls funnel through one subprocess, so they are serialized even when `parallel: true`.

> **💳 Subscription billing note.** With `backend: "pi"`, Anthropic subscription access (Claude Pro/Max) through a third-party harness is billed per-token from your **extra usage** budget, not your plan limits. If Opus errors with `400 ... Add more at claude.ai/settings/usage`, add budget there. GLM-5.2 (free) and GPT-5.4 (ChatGPT subscription) are not affected.

> **🔒 Kimi Code / Kimi K2.** The `kimi-coding` provider is gated to approved coding-agent clients — a direct `backend: "openai"` call returns `access_terminated_error`. It works **only** through the `pi` backend (which presents the approved client identity). Auth it with `pi /login` → *Kimi For Coding*.

## Commands

All commands share these options where relevant:

```
--config <path>   Config file. Default: local-fusion.config.json
--json            (ask) print the full Fusion JSON result
--host <host>     (serve) default 127.0.0.1
--port <port>     (serve) default 8787
--rootDir <path>  (mcp) file-backed run state. Default: ./runs/mcp
--runDir <path>   (looped) artifact trail directory
--step <n>        (looped) current loop step, default 1
--runId <id>      (looped) override the generated run id
```

### `ask` — one-shot council

```sh
node src/cli.mjs ask "Your question or instruction"
node src/cli.mjs ask --json "Your question"           # full trace
node src/cli.mjs ask --config my.config.json "..."    # alternate config
echo "prompt from stdin" | node src/cli.mjs ask --json
```

Without `--json` it prints just `final_answer` (and any degradation notes to stderr). With `--json` it prints the [full result object](#output-schema).

### `serve` — OpenAI-compatible endpoint

```sh
node src/cli.mjs serve --port 8787
```

Then call it like any OpenAI chat endpoint:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "local/fusion",
    "messages": [
      { "role": "user", "content": "What are the strongest arguments for and against carbon taxes?" }
    ]
  }'
```

- The assistant answer is at `choices[0].message.content`.
- The full Fusion trace is attached at the top-level `local_fusion` field of the response.
- Health check: `GET /health` → `{ "ok": true }`.

> The `serve` endpoint is **prose-only** — it returns a synthesized natural-language answer. It is not intended to back a tool-calling agent; for that, use the [MCP server](#mcp--mcp-server-for-claude-code).

### `looped` — Looped PI Fusion

A **prompt driver** layer over an agent loop (implements [`docs/prd-pi-agent-fusion-loop.md`](docs/prd-pi-agent-fusion-loop.md)). It does **not** execute shell, edit files, or run tests — per run it:

1. Resolves model assignments for four view-roles + a conductor from a roster.
2. Dispatches **Explorer / Builder / Critic / Performance Sentinel** views (each a role-specialized council call).
3. The **Loop Conductor** reads the views + a run-state snapshot and emits a machine-parseable decision JSON.
4. Writes an artifact trail under `<runDir>/artifacts/pi-fusion/`.
5. Returns `{ decision, prompt, summary }` for the caller to inject as the next agent prompt.

```sh
node src/cli.mjs looped "Implement and test feature X" \
  --config looped-fusion.config.json \
  --runDir ./runs/last \
  --step 1 \
  --heartbeat fresh
```

This command requires `model_roster` **and** `role_model_policy` in the config — see [`looped-fusion.config.json`](looped-fusion.config.json) and [`docs/using-looped-fusion.md`](docs/using-looped-fusion.md).

| Role | Job |
|---|---|
| Explorer | Map what's actually true: files, symbols, facts vs assumptions, unknowns. |
| Builder | Identify the smallest safe implementation step and its risks. |
| Critic | Challenge the direction: hidden assumptions, failure modes, missing tests. |
| Performance Sentinel | Read loop health (heartbeat, elapsed vs expected, no-progress) and recommend a verdict. |
| Loop Conductor | Synthesize the views + run state into the next prompt (or `complete`). |

### `mcp` — MCP server for Claude Code

Lets **Claude Code / Opus stay the executor** while `local-fusion` becomes the checking + council layer it calls as tools. The flow is pull-based (MCP tools are client-initiated): Claude Code calls a tool, gets the next instruction, executes, reports evidence, and asks again.

**Start the server:**

```sh
node src/cli.mjs mcp --config local-fusion.config.json --rootDir ./runs/mcp
```

The server speaks the **MCP stdio transport (newline-delimited JSON)** that Claude Code uses; legacy LSP-style `Content-Length` framing is also accepted (auto-detected from the client's first bytes).

**Register with Claude Code** (user scope = available in every project):

```sh
claude mcp add local-fusion --scope user -- \
  node /absolute/path/to/local-fusion/src/cli.mjs mcp \
  --config /absolute/path/to/local-fusion/local-fusion.config.json \
  --rootDir /absolute/path/to/local-fusion/runs/mcp

claude mcp get local-fusion          # expect: ✔ Connected
```

Use `--scope project` instead to write a shared `.mcp.json` at the repo root (Claude Code requires explicit approval for project-scoped servers before first use).

**Tools exposed:**

| Tool | Purpose |
|---|---|
| `fusion_ask` | One-shot council on a question; returns final answer + disagreement trace. |
| `looped_start` | Start a build/check loop; freezes objective + acceptance criteria. |
| `looped_report` | Claude Code reports what changed, tests run, blockers, assumptions, evidence. |
| `looped_check_work` | Checker gate: decides `done` / `incomplete` / `blocked` / `uncertain`. |
| `looped_fuse_review` | Conditional full council on the frozen evidence (use only when uncertain/high-risk). |
| `looped_next` | Conductor returns `complete` or one bounded next prompt. |
| `looped_status` | Read current run state and artifact path. |

The default routing keeps the expensive path optional:

```
Opus executes → looped_report → checker gate
   ├─ done + high confidence  → looped_next returns complete
   ├─ incomplete + concrete fix → direct retry prompt
   ├─ uncertain / high-risk    → fusion council → conductor prompt
   └─ blocked                  → pause for human
```

Run artifacts are written under `runs/mcp/<run_id>/` (`state.json`, `report-N.json`, `check-N.json`, `fusion-review-N.json`, `next-N.json`). `runs/` is gitignored. Full details and the recommended Claude Code priming prompt are in [`docs/using-mcp-connector.md`](docs/using-mcp-connector.md).

## Using inside a Pi agent

`local-fusion` can run as a tool a [Pi](https://github.com/badlogic/pi) agent consults for a multi-model second opinion. The Pi skill and project `AGENTS.md` are already set up — launch `pi` from this repo and ask it to *"get a local-fusion council opinion on X"*. See [`docs/using-with-pi.md`](docs/using-with-pi.md).

## Python implementation

A parallel implementation lives in `local_fusion/` with matching core fusion + looped behavior (it does **not** serve MCP — that is Node-only).

```sh
python3 -m local_fusion ask "Compare ridge, lasso, and elastic-net regression."
python3 -m local_fusion ask --json "Design a local-first AI writing assistant architecture"
pbpaste | python3 -m local_fusion ask --json
python3 -m local_fusion serve --port 8787
```

## Output schema

`ask --json` and the MCP `fusion_ask` tool return:

```jsonc
{
  "status": "ok",                       // or "error" when all panel models fail
  "final_answer": "…synthesized answer…",
  "analysis": {
    "consensus": ["points most models agreed on"],
    "contradictions": [
      { "topic": "…", "stances": [{ "model": "…", "stance": "…" }] }
    ],
    "partial_coverage": [{ "models": ["…"], "point": "…" }],
    "unique_insights": [{ "model": "…", "insight": "…" }],
    "blind_spots": ["important missing topics"],
    "judge_notes": ["guidance for the synthesizer"]
  },
  "responses": [{ "model": "…", "content": "raw panel answer" }],
  "failed_models": [{ "model": "…", "error": "…" }],
  "degradation_reasons": ["Some panel models failed.", "…"],
  "raw_judge_output": "…optional raw judge text…"
}
```

When the judge returns non-JSON, `analysis` is a heuristic fallback and `degradation_reasons` explains why.

## Project layout

```
local-fusion/
├─ src/                        # Node implementation (zero dependencies)
│  ├─ cli.mjs                  # entrypoint: ask | looped | serve | mcp
│  ├─ fusion.mjs               # panel → judge → synthesizer core
│  ├─ looped.mjs               # Looped PI Fusion prompt driver
│  ├─ mcp.mjs                  # MCP stdio server (ndjson + Content-Length)
│  ├─ mcp-connector.mjs        # build/check loop logic behind the MCP tools
│  ├─ openai-compatible.mjs    # backend: "openai" transport
│  ├─ pi-transport.mjs         # backend: "pi" transport (headless subprocess)
│  └─ config.mjs               # JSON config loader
├─ local_fusion/              # Python implementation (core parity, no MCP)
├─ test/                       # Node tests (node --test)
├─ tests/                      # Python tests (unittest)
├─ docs/                       # PRD + usage guides + blog posts
├─ .pi/                        # Pi skill + extension for in-agent use
├─ config.example.json         # local-server starter config
├─ local-fusion.config.json    # Pi-subscription council config (default)
└─ looped-fusion.config.json   # roster + role policy for `looped`
```

## Testing

```sh
# Node (23 tests)
node --test

# Python (15 tests)
python3 -m unittest discover -s tests
```

The Node suite covers the fusion core, the looped driver, the MCP connector routing, **and the MCP wire transport** — including framing detection and a full newline-delimited `initialize`/`tools/list` handshake, so the Claude Code transport can't silently regress.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `claude mcp get` shows **✘ Failed to connect** | Confirm the `node … mcp` command runs standalone and the paths are absolute. The server now speaks newline-delimited JSON; older builds only spoke `Content-Length`. |
| MCP server shows **⏸ Pending approval** | Project-scoped servers need approval — run `claude` and approve, or register with `--scope user`. |
| `fusion_ask` / `looped_check_work` return errors with the Pi backend | Pi must be logged in (`pi /login`). The MCP transport being healthy is separate from the models behind it. |
| Opus errors `400 … Add more at claude.ai/settings/usage` | Subscription extra-usage budget exhausted — add budget. |
| `access_terminated_error` on Kimi | Don't call Kimi via `backend: "openai"`; use `backend: "pi"`. |
| `degradation_reasons` populated | Some panel models / the judge failed; check the listed reasons and `failed_models`. |
| `looped needs model_roster and role_model_policy` | Point `--config` at `looped-fusion.config.json` (or a config with those keys). |

## Limitations

- **MCP serving is Node-only.** Python has core fusion/looped parity but does not serve MCP stdio.
- **MCP is pull-based.** Claude Code must call the tools; `local-fusion` cannot push into an already-running conversation.
- **`pi`-backend calls are serialized** through one subprocess even with `parallel: true`.
- **GLM quota** can degrade the council — check `degradation_reasons` in `fusion_ask` / `looped_fuse_review` output.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the test
commands, and the PR flow. `main` is protected: all CI checks (Node 20/22, Python 3.10/3.12)
must pass before merge.

## License

[MIT](LICENSE) © Kelvin Cushman
