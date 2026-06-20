# local-fusion MCP connector

The MCP connector lets **Claude Code / Opus remain the executor** while local-fusion becomes
the checking and council layer it can call as tools.

The flow is pull-based because MCP tools are client-initiated: Claude Code calls the local
connector, receives the next instruction, executes it, reports evidence, and asks again.
There is no brittle terminal-control bridge and no copy/paste relay.

## Start the server

```bash
node src/cli.mjs mcp --config local-fusion.config.json --rootDir ./runs/mcp
```

For Claude Code, register the server (user scope makes it available in every project):

```bash
claude mcp add local-fusion --scope user -- \
  node /Users/kelvincushman/dev/local-fusion/src/cli.mjs mcp \
  --config /Users/kelvincushman/dev/local-fusion/local-fusion.config.json \
  --rootDir /Users/kelvincushman/dev/local-fusion/runs/mcp
```

Verify with `claude mcp get local-fusion` (expect `✔ Connected`). The server speaks the
MCP stdio transport (newline-delimited JSON); legacy `Content-Length` framing is also
accepted.

## Tools

| Tool | Purpose |
|------|---------|
| `fusion_ask` | Single-shot council: GLM/GPT/Kimi answer the same question, judge+synth returns final answer plus disagreement trace. |
| `looped_start` | Start a build/check loop and freeze the objective + acceptance criteria. |
| `looped_report` | Claude Code / Opus reports what it changed, what tests ran, blockers, assumptions, and raw evidence. |
| `looped_check_work` | GPT checker gate: decides if Opus's work is `done`, `incomplete`, `blocked`, or `uncertain`. |
| `looped_fuse_review` | Conditional full council on the frozen evidence + checker findings. Use only when uncertain/high-risk. |
| `looped_next` | Conductor returns either `complete` or one bounded next prompt for Opus. |
| `looped_status` | Read current run state and artifact path. |

## Recommended Claude Code instruction

Use this as the initial Claude Code prompt:

```text
You have access to the local-fusion MCP tools. For this build, do not ask me for the next
prompt after each phase.

1. Call looped_start with the objective and acceptance criteria.
2. Execute the returned next_prompt using your normal coding workflow and subagents.
3. After each phase, call looped_report with summary, changed_files, tests/tests_run,
   test_output, blockers, assumptions, acceptance_status, and raw_evidence.
4. Call looped_check_work.
5. If looped_check_work recommends stop, call looped_next and stop if status=complete.
6. If it recommends direct_retry, call looped_next and execute its next_prompt.
7. If it recommends fusion_review, call looped_fuse_review, then looped_next, then execute
   the returned next_prompt.
8. Stop only when looped_next.status is complete or pause_for_human.

Every report must cite concrete evidence: files changed, commands run, test output, and
which acceptance criteria are satisfied or still unverified.
```

## Why the checker exists before fusion

The expensive path is not always necessary. The default routing is:

```text
Opus executes
  ↓
looped_report
  ↓
GPT checker gate
  ├─ done + high confidence → looped_next returns complete
  ├─ incomplete + concrete fix → looped_next returns direct retry prompt
  ├─ uncertain / low confidence / high-risk → fusion council → conductor prompt
  └─ blocked → pause_for_human
```

This preserves the value of the council without running a full multi-model review on every
green build.

## Evidence contract

`looped_report` should include:

```json
{
  "run_id": "...",
  "summary": "What was implemented",
  "changed_files": ["src/example.ts"],
  "tests": ["npm test"],
  "test_output": "Relevant output, not necessarily the whole log",
  "blockers": [],
  "assumptions": [],
  "acceptance_status": "Which acceptance criteria are satisfied/unverified",
  "raw_evidence": "Optional extra diff/test/build notes"
}
```

The checker returns:

```json
{
  "status": "done | incomplete | blocked | uncertain",
  "confidence": 0.0,
  "missing_requirements": [],
  "likely_bugs": [],
  "verification_gaps": [],
  "exact_next_actions": [],
  "evidence_used": [],
  "recommended_route": "stop | direct_retry | fusion_review | human",
  "handoff_reason": "..."
}
```

Every criticism should cite evidence. If evidence is missing, the finding should be a
`verification_gap`, not a hallucinated bug.

## Artifacts

Runs are stored under `runs/mcp/<run_id>/`:

```text
state.json
report-1.json
check-1.json
fusion-review-1.json
next-1.json
```

`runs/` is gitignored.

## Current limits

- Node implementation only for the MCP server; Python parity remains for core fusion/looped
  logic but not MCP stdio serving.
- MCP is pull-based. Claude Code must call the tools; local-fusion cannot push into an
  already-running Claude Code conversation.
- GLM quota can degrade the council; check `degradation_reasons` in `fusion_ask` or
  `looped_fuse_review` outputs.
