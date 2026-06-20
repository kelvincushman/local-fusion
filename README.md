# local-fusion

Run an OpenRouter Fusion-style model council locally, without OpenRouter.

This is a small standalone runner that talks to local OpenAI-compatible model servers. It sends your prompt to several local models, asks a judge model for structured comparison JSON, then asks a synthesizer model to write the final answer.

## What It Recreates

OpenRouter Fusion has five useful ideas:

1. A panel of configurable models answers the same prompt.
2. Panel calls run in parallel when the runtimes can handle it.
3. A judge compares the answers instead of simply merging them.
4. The judge returns structured analysis: consensus, contradictions, partial coverage, unique insights, blind spots, and notes.
5. A final model synthesizes the answer from the raw responses plus judge analysis.

`local-fusion` implements that harness locally. It does not use OpenRouter, web search, web fetch, billing, or hosted routers.

Reference: [OpenRouter Fusion Router docs](https://openrouter.ai/docs/guides/routing/routers/fusion-router) and the original announcement link you shared.

## Requirements

- Python 3.10+
- One or more local model servers exposing `/v1/chat/completions`

Known compatible options:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`
- llama.cpp server: often `http://localhost:8080/v1`
- vLLM, MLX, LocalAI, or anything else with an OpenAI-compatible chat API

## Setup

```sh
cd /Users/kelvincushman/dev/local-fusion
cp config.example.json local-fusion.config.json
```

Edit `local-fusion.config.json` so each `baseUrl` and `model` matches the local servers you are actually running.

For Ollama, for example:

```sh
ollama pull qwen2.5-coder:14b
ollama serve
```

Then set a config entry like:

```json
{
  "name": "qwen-coder-local",
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "ollama",
  "model": "qwen2.5-coder:14b"
}
```

## CLI Usage

```sh
python3 -m local_fusion ask "Compare ridge, lasso, and elastic-net regression. Where does each shine?"
```

Print the full Fusion trace:

```sh
python3 -m local_fusion ask --json "Design a local-first AI writing assistant architecture"
```

Pipe a prompt:

```sh
pbpaste | python3 -m local_fusion ask --json
```

## Local OpenAI-Compatible Server

Start the local Fusion server:

```sh
python3 -m local_fusion serve --port 8787
```

Call it like a normal OpenAI-compatible endpoint:

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

The normal assistant answer is returned at:

```text
choices[0].message.content
```

The full trace is returned at:

```text
local_fusion
```

## Configuration

Top-level options:

- `parallel`: `true` runs panel calls concurrently. Set `false` if your machine cannot load several local models at once.
- `timeoutMs`: per-call timeout.
- `panel`: model configs for independent first-pass answers.
- `judge`: model config for structured comparison JSON.
- `synthesizer`: optional model config for final synthesis. Defaults conceptually to the judge role when omitted.

Each model config:

- `name`: readable trace name.
- `backend`: optional. `"openai"` (default) POSTs to `baseUrl` directly; `"pi"` drives a
  headless Pi subprocess and uses Pi's stored auth (including OAuth subscriptions such
  as ChatGPT/Claude Pro and ZAI) — no API key of your own needed. `pi` entries use
  `provider` + `modelId` instead of `baseUrl`/`apiKey`.
- `provider`/`modelId`: required when `backend` is `"pi"` (e.g. `zai`/`glm-5.2`,
  `openai-codex`/`gpt-5.4`, `anthropic`/`claude-opus-4-8`, `kimi-coding`/`kimi-k2-thinking`).
  Discover exact ids with `pi --list-models`.
- `baseUrl`: OpenAI-compatible base URL ending in `/v1` (only for the default backend).
- `apiKey`: dummy value is fine for local servers that ignore auth.
- `apiKeyEnv`: optional environment variable name if the server needs a key.
- `model`: model name expected by that server.
- `temperature`: sampling temperature.
- `maxTokens`: max response tokens.
- `system`: optional role prompt for this model.

> **Subscription billing note.** With `backend: "pi"`, Anthropic subscription access
> (Claude Pro/Max) through a third-party harness is billed per-token from your **extra
> usage** budget, not your plan limits. If Opus errors with
> `400 ... Add more at claude.ai/settings/usage`, add budget there. GLM-5.2 (free) and
> GPT-5.4 (ChatGPT subscription) are not affected.

## Using Pi subscription models (no API keys needed)

Besides local OpenAI-compatible servers, `local-fusion` can drive the models you have
configured in [Pi](https://github.com/badlogic/pi) — including OAuth subscriptions
(ChatGPT Plus/Pro, Claude Pro/Max) and ZAI — by spawning a headless `pi` subprocess.
local-fusion needs no API keys of its own; Pi owns all auth via `~/.pi/agent/auth.json`.

Set `backend: "pi"`, `provider`, and `modelId` on each entry (the shipped
`local-fusion.config.json` runs GLM-5.2 + GPT-5.4 + Opus this way):

```jsonc
{
  "parallel": false,
  "panel": [
    { "name": "glm52", "backend": "pi", "provider": "zai",           "modelId": "glm-5.2",            "system": "careful generalist" },
    { "name": "gpt54", "backend": "pi", "provider": "openai-codex", "modelId": "gpt-5.4",            "system": "precise implementer" },
    { "name": "kimi",  "backend": "pi", "provider": "kimi-coding",  "modelId": "kimi-k2-thinking", "system": "skeptical critic" }
  ],
  "judge":       { "backend": "pi", "provider": "kimi-coding",  "modelId": "kimi-k2-thinking" },
  "synthesizer": { "backend": "pi", "provider": "openai-codex", "modelId": "gpt-5.4" }
}
```

All `pi`-backend calls are serialized through one subprocess even when `parallel: true`.
`temperature`/`maxTokens` are ignored for `pi` entries (the agent's own settings apply);
the role `system` prompt and the task are what matter.

> **Kimi Code / Kimi K2.** Kimi Code (`kimi-coding` provider) is gated to approved
> coding-agent clients — a direct `backend: "openai"` call returns
> `access_terminated_error`. It only works through the `pi` backend, which presents the
> approved client identity. Available ids include `kimi-k2-thinking`, `kimi-for-coding`,
> and `k2p7`. Auth it with `pi /login` → Kimi For Coding (stored in `auth.json`).

## Practical Local Presets

Small laptop:

- Use one 7B-14B model twice with different `system` prompts.
- Set `parallel: false`.
- Use the strongest local model as judge and synthesizer.

Workstation:

- Run 2-4 different model families.
- Keep `parallel: true`.
- Give each panel member a different perspective: implementer, critic, simplifier, researcher.

Best results usually come from diversity plus a strict judge. Fusing the same model with different perspectives can still help, but it is mostly extra test-time compute rather than true model diversity.

## Using Inside a Pi Agent

`local-fusion` can run as a **tool that a [Pi](https://github.com/badlogic/pi) agent consults**
for a multi-model second opinion (it is not used as Pi's model backend — the `serve` endpoint
is prose-only). The Pi skill and project `AGENTS.md` are already set up. Launch `pi` from this
repo and ask it to "get a local-fusion council opinion on X".

See [docs/using-with-pi.md](docs/using-with-pi.md) for the single-shot council walkthrough,
[docs/using-looped-fusion.md](docs/using-looped-fusion.md) for the **Looped PI Fusion**
deliberation layer (`/looped` slash command), and
[docs/using-mcp-connector.md](docs/using-mcp-connector.md) for the Claude Code / Opus MCP
connector that checks executor work, conditionally invokes Fusion, and returns the next prompt.

## Test

```sh
python3 -m unittest discover -s tests
```

There is also a dependency-free Node.js implementation in `src/` with matching behavior:

```sh
node src/cli.mjs ask "Compare two approaches"
node src/cli.mjs serve --port 8787
node src/cli.mjs mcp --config local-fusion.config.json --rootDir ./runs/mcp
node --test
```
