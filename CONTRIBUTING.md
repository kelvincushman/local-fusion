# Contributing to local-fusion

Thanks for your interest in improving `local-fusion`. This guide covers local setup, how
to run the tests, and the pull request flow.

## Project shape

`local-fusion` has two parallel implementations and zero runtime dependencies:

- **Node** (`src/`) — the full feature set: `ask`, `serve`, `looped`, and the `mcp` server.
- **Python** (`local_fusion/`) — core `ask`/`looped` parity (no MCP serving).

Because there are no dependencies, there is **nothing to install** to develop the Node side
beyond Node itself. See the [README](README.md) for the architecture and command reference.

## Prerequisites

- **Node.js ≥ 20** (CI runs 20 and 22).
- **Python ≥ 3.10** if you touch the Python side (CI runs 3.10 and 3.12).
- Optional, only to run a live council locally:
  - A local OpenAI-compatible server (Ollama / LM Studio / llama.cpp / …), and/or
  - [Pi](https://github.com/badlogic/pi) authenticated (`pi /login`) for subscription models.

Tests do **not** require any model server or network access — model transports are injected
or stubbed, so the suites run fully offline.

## Setup

```sh
git clone https://github.com/kelvincushman/local-fusion.git
cd local-fusion
node src/cli.mjs --help          # verify the Node runtime works
```

## Running the tests

Both suites must pass; CI runs exactly these commands:

```sh
node --test                              # Node suite
python3 -m unittest discover -s tests    # Python suite
```

To run a single Node test file while iterating:

```sh
node --test test/mcp-connector.test.mjs
```

## Making a change

1. **Branch off `main`.** `main` is protected — all four CI checks (Node 20/22, Python
   3.10/3.12) must pass before a PR can merge, and the branch must be up to date.

   ```sh
   git checkout -b fix/short-description
   ```

2. **Write a test first when you can.** New behavior should come with a test in `test/`
   (Node) and/or `tests/` (Python). Bug fixes should add a regression test that fails
   before the fix.

3. **Keep both implementations in sync** when you change shared behavior. If you change
   core fusion/looped logic on one side, mirror it on the other (or note in the PR why
   parity does not apply — e.g. MCP is Node-only).

4. **Run both suites locally** before pushing (commands above).

5. **Open a PR.** The [PR template](.github/pull_request_template.md) will prompt you for a
   summary, the area touched, and test evidence. Fill it in — paste the relevant tail of
   the test output, not the whole log.

## Coding conventions

- **Match the surrounding code.** Both implementations are plain, dependency-free, and
  favor small focused functions and explicit error handling over cleverness.
- **Preserve degradation tolerance.** The harness is designed to survive partial failure
  (a panel model down, a non-JSON judge, a failed synthesizer). Don't turn a recoverable
  failure into a hard crash — record it in `degradation_reasons` instead.
- **Be careful with the MCP wire transport.** `src/mcp.mjs` auto-detects newline-delimited
  JSON (the MCP stdio spec, used by Claude Code) and legacy `Content-Length` framing. Any
  change there must keep both working and is covered by transport tests — keep them green.
- **Don't break config compatibility** silently. New config keys should be optional with
  sensible defaults; document them in the README's configuration reference.

## Commit messages

Use conventional-commit-style prefixes where natural: `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`, `ci:`. Keep the subject line tight and explain the *why* in the body
when it isn't obvious.

## Security

- **Never commit real secrets, API keys, or tokens.** Configs in the repo use dummy
  placeholder keys (`ollama`, `lm-studio`, …) or the `pi` backend (which reuses Pi's stored
  auth). Redact keys from any output or config you paste into issues/PRs.
- Found a security issue? Please avoid filing a public issue with exploit detail — open a
  minimal report and we'll coordinate from there.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
