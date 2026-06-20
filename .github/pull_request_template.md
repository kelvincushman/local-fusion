<!--
Thanks for contributing to local-fusion!
Keep the summary tight and the evidence concrete. CI must be green before merge
(Node 20/22 + Python 3.10/3.12) — see the branch protection on `main`.
-->

## Summary

<!-- What does this PR do, and why? One or two sentences. -->

## Changes

<!-- Bullet the notable changes. Reference files/areas where helpful. -->

-

## Area(s) touched

<!-- Tick all that apply. -->

- [ ] Fusion core (`ask` / `src/fusion.mjs` / `local_fusion/core.py`)
- [ ] OpenAI-compatible server (`serve`)
- [ ] Looped PI Fusion (`looped` / `src/looped.mjs`)
- [ ] MCP server / connector (`mcp` / `src/mcp.mjs` / `src/mcp-connector.mjs`)
- [ ] Backends / transport (`openai-compatible.mjs` / `pi-transport.mjs`)
- [ ] Config / schema
- [ ] Docs only
- [ ] CI / tooling

## Testing

<!-- Show the evidence. Paste the relevant tail of the output, not the whole log. -->

- [ ] `node --test` passes
- [ ] `python3 -m unittest discover -s tests` passes
- [ ] Added/updated tests for the change (or N/A — explain why)

```
# paste relevant test output
```

## Checklist

- [ ] No real secrets, API keys, or tokens committed (configs use dummy/placeholder keys)
- [ ] Docs updated if behavior, config, or commands changed (README / `docs/`)
- [ ] Backward compatibility considered (e.g. MCP wire framing, config shape)

## Related issues

<!-- e.g. Closes #123 -->
