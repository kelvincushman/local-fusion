# The Council Checks the Work

*Building an autonomous loop where a council of AI agents reviews and approves every step — and watching it catch four real bugs a single reviewer waved through.*

By **Kelvin Lee** · [kelvinlee.uk](https://www.kelvinlee.uk)

---

I wrote a small feature. A cheap automated reviewer looked at it, gave me 89% confidence, and said *ship it*. Then I handed the exact same code to a council of three models. They found four real bugs.

All four were legitimate. I fixed every one.

That gap — between "one reviewer says done" and "a council says wait" — is the whole point of what I've been building. This is the story of testing it end to end, one step at a time, on its own codebase.

## The setup

The tool is called [local-fusion](https://github.com/kelvincushman/local-fusion). It runs an OpenRouter-Fusion-style council locally: several models answer independently, a judge maps where they agree and disagree, and a synthesizer folds the best of each into one answer. No single model gets the last word.

It exposes seven tools over MCP. Two families matter here:

- `fusion_ask` — ask the council one question.
- `looped_*` — an autonomous execution loop: define an objective, build, report, gate it through a cheap checker, escalate to the full council when needed, repeat until done.

I registered the MCP server in my editor and started poking at it.

## Step 1: Does the council actually disagree?

A council is only worth the tokens if the models genuinely push on each other. So I started with a real technical question — one where I already knew the right answer, because I'd just fixed this exact bug in the server's own transport layer:

> *In a Node.js MCP stdio server, what's the correct way to frame JSON-RPC messages — newline-delimited JSON or LSP-style Content-Length headers? Give a minimal, correct implementation for a stdin stream that may deliver partial chunks.*

I ran it with the full trace on. Three models answered: a generalist, a builder, and a critic. The judge's output is what sold me — it didn't average them, it surfaced where they *split*:

| Topic | Generalist | Builder | Critic |
|---|---|---|---|
| Carriage-return handling | `.trim()` the line | ⚠️ `.trim()` corrupts JSON → `.replace(/\r$/,'')` | `.replace(/\r$/,'')` |
| Bad frames | emit `-32700` | silently continue | flags its own code/prose inconsistency |
| Is newline-framing universal? | MCP-correct | "MCP chose it" | ⚠️ **not** universal — depends on the peer |

The synthesizer resolved the conflict the way I would have: it took the builder's safer `.replace(/\r$/,'')` over the generalist's `.trim()`, kept the critic's warning that newline-delimited JSON is an MCP-specific convention, and added the critic's two operational risks — stdout pollution and unbounded buffer growth from a peer that never sends a newline.

The kicker: the council independently re-derived the *exact* framing fix I'd already shipped to this server. Different angles, same correct conclusion. That's the signal I wanted.

## Step 2: Drive the autonomous loop

`fusion_ask` is a single shot. The interesting part is the loop. I gave it a real, small objective and three frozen acceptance criteria:

> **Objective:** Add a `--version` flag to the CLI that prints the version from `package.json` and exits 0.
>
> **Criteria:** (1) prints the version string, (2) exits 0, (3) a regression test asserts the printed version matches `package.json`.

`looped_start` froze those criteria and handed me back the first executor prompt. The criteria are now immutable for the run — the loop can't quietly redefine "done" later. That matters more than it sounds.

I didn't want to feed the loop fake evidence, so I actually built the feature. Added the flag, ran it, wrote the test:

```
$ node src/cli.mjs --version
0.1.0
exit=0
```

Then I reported the real result back through `looped_report` — files changed, test output, blockers, assumptions — and called the gate.

## Step 3: Watch the cheap checker rubber-stamp it

`looped_check_work` runs a single fast model as a gate *before* spending council tokens. This is the cost-aware part: most steps are fine, and you don't want a five-model panel on every trivial change.

Here's what the checker said about my code:

```json
{
  "status": "done",
  "confidence": 89,
  "missing_requirements": [],
  "likely_bugs": [],
  "verification_gaps": [],
  "recommended_route": "stop"
}
```

Done. No bugs. No gaps. Ship it.

If the loop stopped there, I'd have committed it and moved on. And I'd have been wrong.

## Step 4: Escalate to the council

Normally the council review only fires when the checker is *uncertain*. But I wanted to see what a deeper look would catch on code the checker had already cleared, so I invoked `looped_fuse_review` directly. The council read the same evidence the checker did.

It came back with four issues — and the judge noted, in writing, that *"the primary checker is overreaching by claiming zero verification gaps."*

1. **The `-v` alias is scope creep.** I'd added `-v` as a shortcut. Nobody asked for it, and `-v` almost universally means `--verbose`. The critic flagged it as the single most predictable future collision. It was right — I'd over-built.

2. **`process.exit(0)` can truncate piped output.** My code did `console.log(version); process.exit(0)`. The generalist called it "the classic Node truncation bug": exit before the stdout buffer drains and `local-fusion --version | grep` can lose the line. One passing run doesn't prove it's safe.

3. **My test was partly tautological.** It resolved `package.json` using the *same* path logic as the code under test. A bug in that resolution would pass silently on both sides. The fix: resolve the expected version independently, and assert the exit code directly instead of trusting the test's name.

4. **A blind spot the checker never raised:** the repo has parallel Node and Python CLIs. I'd only added `--version` to Node. The Python CLI was now out of parity.

None of these are exotic. They're the exact kind of "works on the happy path, breaks in a pipe" issues that a fast reviewer waves through because the acceptance criteria *technically* pass. The council didn't disagree that the criteria were met. It disagreed that "criteria met" means "robust."

## Step 5: Apply the fixes and close the loop

I took all four:

```js
// Before — council flagged both the alias and the truncation risk
if (command === '--version' || command === '-v') {
  console.log(readVersion());
  process.exit(0);
}

// After — single flag, drain stdout naturally, no truncation
if (command === '--version') {
  process.stdout.write(`${readVersion()}\n`);
  process.exitCode = 0;
}
```

I rewrote the test to resolve the version independently and assert the exit code with `spawnSync`. I added a matching `--version` to the Python CLI, reading the same `package.json` with a graceful fallback so a single source of truth stays single.

Then I verified:

- Node `--version` → `0.1.0`, exit 0; piped → no truncation.
- `-v` → now correctly rejected.
- Python `--version` → `0.1.0`, exit 0. Parity restored.
- Full suite: **24/24 passing** (up from 23).

`looped_next` folded the checker result and the review into one decision: **complete**. `looped_status` showed the whole run on disk — one report, one check, one fusion review, one conductor output — every step auditable after the fact.

I committed it on a branch with the council's reasoning written into the message. The loop had reviewed and approved its own workflow, and left a paper trail.

## "Isn't this just hype?" — the Scott Logic test

Here's where I have to be honest with myself, because someone else already made the argument I'd be dodging.

In June 2026, Colin Eberhardt (CTO of Scott Logic) wrote ["Ponytail? YAGNI!"](https://blog.scottlogic.com/2026/06/16/ponytail-yagni-and-the-problem-with-prompt-benchmarks.html). He took a trending Claude Skill — 20k GitHub stars in a week, impressive benchmark numbers — dug in, and found it was ~100 lines of markdown restating the 1990s YAGNI principle, wrapped in a 6,000-line repo of noise. Then he reproduced its benchmark and showed it was rigged in its own favour: the baseline was penalised for emitting multiple code options because it had no agent system prompt. He **beat the tool's own score with seven words** of plain prompt: *"Follow YAGNI principles, and one-liner solutions."*

His rule, which I think is correct: **if a tool can't substantiate its claims with a real benchmark, it's almost certainly riding the hype wave — and the cooler it looks, the faster it's riding.**

Everything above this line is exactly what he's warning about. A slick story, a satisfying "the council caught four bugs!" anecdote — and a sample size of one. Worse, one of the four bugs the council caught was the unrequested `-v` alias: a scope-creep, over-engineering miss. That's *literally a YAGNI violation*. I'd written a post celebrating my tool for catching the exact thing Colin's whole article is about, and I'd backed it with n=1.

So I did the thing he says almost nobody does. I built a benchmark.

## I ran the numbers

The claim under test is narrow and falsifiable: **does the council catch real issues that a single reviewer misses — and does it beat a *good* single reviewer, not a strawman?**

The harness (`eval/council-vs-checker.mjs`, ~200 lines, no framework) runs three reviewers over **identical frozen evidence**:

- **Checker** — the production gate: one model, the terse "is this done?" prompt.
- **Strong single reviewer** — the *same model*, but an exhaustive "list every real bug, gap, security issue, and scope problem" prompt. This is the fair baseline Colin demands.
- **Council** — panel + judge + synthesizer, same evidence body.

Holding the model fixed between the first two arms isolates the variable: checker-vs-single is *prompt*, single-vs-council is *one perspective vs many*.

The dataset (`eval/fixtures.mjs`) is six realistic "build reports" that **meet their acceptance criteria but hide known, planted issues** — deliberately using Colin's own task themes (rate limiting, csv-sum, debounce, JWT auth) plus the `--version` case from this post, plus one **clean control** with no planted issues to check the council doesn't just invent problems. Grading is a coarse, deterministic keyword match (no LLM-as-judge), and every raw output is published so anyone can re-grade. Results are averaged over three trials per fixture because the models are non-deterministic.

Detection rate of planted issues, 3 trials per fixture (higher is better):

| Fixture | Planted issues | Checker | Strong single reviewer | Council |
|---|---|---|---|---|
| version-flag | 4 | 17% | 50% | **75%** |
| fastapi-rate-limit | 4 | 67% | 100% | **100%** |
| csv-sum | 3 | 0% | 33% | **56%** |
| debounce | 3 | 33% | 33% | 33% |
| jwt-auth | 4 | 100% | 100% | **100%** |
| **Overall** | **18** | **42%** | **64%** | **74%** |

*(One `jwt-auth` trial timed out and was excluded. "Detected" means a planted issue's keyword appears in that arm's output. Raw per-run outputs and `eval/RESULTS.md` are in the repo — re-grade them yourself.)*

I committed to shrinking the claim if the council didn't clearly beat a *strong* single reviewer. So here's the honest read: **it does beat it — by 10 points, not a chasm.** A council of disagreeing models caught more planted issues (74%) than a good single reviewer working from the same evidence (64%), which in turn crushed the cheap production checker (42%).

But look at the rows, because the average hides the texture. On `jwt-auth` and `fastapi-rate-limit` the single reviewer already hit 100% and the council just matched it — extra models bought nothing. On `debounce`, all three tied at 33% and the council added zero. The council's real wins were `version-flag` and `csv-sum`: scope-creep and robustness gaps that a single pass noticed less reliably across trials. And there's a cost — on the clean control with no planted issues, the council and single reviewer each raised ~1 "serious problem" signal on average where the terse checker raised none. More eyes find more, including things that aren't there.

So the council helps most exactly where you'd hope — subtle, easy-to-rationalise-away issues like unrequested scope — and helps least when the problem is either obvious (a good reviewer already catches it) or phrased in a way my coarse keyword grader can't see. That's a real edge, honestly measured, not a revolution.

## What actually made the difference

Strip the hype and the mechanism is mundane: when the same model writes the code and reviews the code, the review inherits the author's blind spots. The 89% confidence wasn't a lie — the model genuinely couldn't see what it couldn't see. A single reviewer, however strong, is one perspective applied twice.

Three boring design choices are what made the loop useful, and they're worth more than the council itself:

- **Frozen acceptance criteria.** "Done" is fixed before the work starts, so the loop is measured against a target that can't drift.
- **A cheap gate before an expensive panel.** A fast checker clears the easy majority; the council is reserved for the uncertain and the risky. Cost curve, not flat tax.
- **Disagreement as a first-class artifact.** The synthesized answer is useful; the *trace of where the models split* is more useful — an auditable map of where the risk actually lives.

## What it isn't

I'll keep this honest, because the council would.

It costs more tokens than one model — the cheap-gate-then-escalate design bounds that, but a full panel on every trivial edit is waste. It is not a correctness oracle: models that share a blind spot will confidently share a wrong answer, which is why frozen criteria and real test output stay in the loop as ground truth. Someone still has to author honest acceptance criteria; the loop only enforces them.

And the load-bearing caveat, straight from Colin: **effectiveness = skill + model + harness.** These numbers are specific to this model lineup and this harness; a newer model, or a single reviewer with a sharper prompt, could close the gap. The benchmark is small, the grading is coarse, and planted issues are not real pull requests. So treat it as what it is — a reproducible starting point you can run and attack yourself — not a law.

That's the only claim I'll defend: on this dataset, with this harness, a council of disagreeing models caught issues a single reviewer missed, and you can re-run the eval and check.

---

*The implementation, the eval harness, and the raw results are open source at [github.com/kelvincushman/local-fusion](https://github.com/kelvincushman/local-fusion). Re-run the benchmark yourself with `npm run eval`. Every trace in this post came from live runs against that repo.*
