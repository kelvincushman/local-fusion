# local-fusion

A small, dependency-free runner that reproduces an OpenRouter Fusion-style model council
against **local** OpenAI-compatible servers or Pi-authenticated model subscriptions: a panel
of models answer the same prompt, a judge compares them as structured JSON, and a synthesizer
writes the final answer. Two parity implementations exist for the core council — Node
(`src/`) and Python (`local_fusion/`). The MCP connector is Node-only.

## You can consult the council as a tool

A `local-fusion` skill is installed under `.pi/skills/`. When a decision in this repo is
ambiguous or high-stakes and a second opinion would help, get a deliberated multi-model
answer with `node src/cli.mjs ask --json "<question>"`. Pi loads that skill on demand —
see it for the exact commands and how to read the trace. Your own model still drives the
session; local-fusion is only a tool you call.

## Project map

- `src/` — Node implementation (`cli.mjs`, `fusion.mjs`, `openai-compatible.mjs`, `config.mjs`, `pi-transport.mjs`, `looped.mjs`, `mcp.mjs`, `mcp-connector.mjs`). No dependencies; needs Node 20+.
- `local_fusion/` — Python implementation (`core.py`, `cli.py`, `pi_transport.py`, `looped.py`). Stdlib only; needs Python 3.10+.
- `test/fusion.test.mjs` + `test/looped.test.mjs` + `test/mcp-connector.test.mjs` — Node tests (`node --test`); mock the pi client + inject fake call.
- `tests/test_fusion.py` + `tests/test_looped.py` — Python tests (`python3 -m unittest discover -s tests`); same hermetic pattern.
- `config.example.json` — template. Copy to `local-fusion.config.json` (the runtime config) and point each entry at a server you actually run. `looped-fusion.config.json` holds the roster + role→model policy for Looped PI Fusion.
- `.pi/extensions/looped-fusion.ts` — Pi `/looped` slash command (auto-loaded project extension).
- `.mcp/local-fusion.json` — example Claude Code MCP config for the local-fusion stdio server.
- `docs/` — design docs, including `prd-pi-agent-fusion-loop.md` (the Looped PI Fusion spec, now implemented), `using-with-pi.md`, `using-looped-fusion.md`, and `using-mcp-connector.md`.

## Workflow when changing code

1. Keep the Node and Python core fusion/looped implementations behavior-matched — a change to one usually needs the mirror change in the other. MCP stdio serving is currently Node-only; don't imply Python exposes MCP unless implemented.
2. Run BOTH suites before claiming done: `node --test` and `python3 -m unittest discover -s tests`. Tests are hermetic (no real model calls).
3. Match the existing immutable, small-function style.

## Constraints

- Local-only by design: no OpenRouter, cloud routing, web search, or web fetch. Don't add network dependencies.
- Known limitation: the `serve` OpenAI-compatible endpoint is **prose-only** — it ignores `tools` and does not stream. So local-fusion cannot currently be a tool-calling agent's model backend (only a consultable tool). The MCP connector is different: it exposes local-fusion as tools to Claude Code/Opus, but it is pull-based and cannot push prompts into an already-running Claude Code terminal.
- `local-fusion.config.json` holds local server URLs/keys, **or** `backend: "pi"` entries that reuse Pi's stored auth (OAuth subscriptions included). Never commit real secrets.
- Two transports exist: the default `openai` backend (local-fusion POSTs itself) and the `pi` backend (drives a headless `pi --mode rpc` subprocess via `~/.pi/agent/auth.json`). Keep them behavior-matched. With `backend: pi`, Anthropic subscription calls bill against the account's **extra usage** budget, not plan limits — surface that to users if Opus errors.
- Don't commit, push, or rewrite git history unless explicitly asked.
