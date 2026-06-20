# Looped PI Fusion

There is a point where an agent loop stops feeling like a clever prompt and starts feeling like a small operating system.

Not because it is magical. Usually the opposite. It gets useful when it becomes boring in the right places.

It has a run folder.

It writes down what it did.

It records heartbeats.

It knows when it might be stuck.

It hands off to the next agent without pretending the last agent was omniscient.

That is the shape I have been circling with PI agents. A PI agent is not just a model answering in a chat box. It is a role inside a durable loop. It leaves evidence behind. It writes artifacts for the next role. It runs in a worktree when it needs isolation. It can be checked by another agent instead of grading itself.

But there is still a missing piece.

A loop can be durable and still be narrow.

It can keep moving, keep writing files, keep updating its heartbeat, and still be following the first bad framing it gave itself twenty minutes ago.

That is where Fusion becomes interesting.

## The problem with one loop thinking alone

Most agent loops are basically this:

```text
inspect -> reason -> act -> verify -> record -> continue
```

That is already better than a one-shot prompt. It gives the agent a way to keep going until a condition is true. It gives you a trail. It gives the next turn something to read instead of starting cold.

But the loop is still often one mind talking itself forward.

The same role that explored the code decides what matters. The same role that picked the implementation path decides what risk is acceptable. The same role that got excited about the fix decides what the next prompt should be.

That is fine for small tasks. It is not fine for longer autonomous work.

Longer work needs friction. Not chaos, not committee theatre, just useful friction. A second view. A critic. A performance check. Somebody asking whether the loop is actually making progress or just burning time in a polite circle.

PI agents already give us the place to put that friction, because the loop has artifacts. Once the state is outside the model, other roles can read it.

## Fusion, but for PI agents

OpenRouter calls its version Fusion: several models answer, a judge compares the answers, and a final answer gets synthesized from the disagreement.

The useful part is not the branding. The useful part is the shape.

Multiple independent views first. Synthesis second.

For PI agents, I would change the purpose a bit. I do not just want a better final answer. I want a better next move.

That is the difference.

In a normal Fusion setup, the output is usually an answer to the user. In a PI loop, the output should often be the next prompt that drives the loop.

So the pattern becomes:

```text
PI views -> Loop Conductor -> next PI prompt -> execution -> evidence -> repeat
```

The loop is still the loop. Worktrees still isolate file changes. Skills still carry project memory. Connectors still let the system touch real tools. Heartbeats still show whether the run is alive. Verification still decides whether a claim is true.

Fusion sits before the next prompt and asks: given what all these PI agents saw, what should the loop do next?

## Why I do not like the word judge

I get why OpenRouter uses "judge". It is simple. It tells you one model is comparing the others.

But inside an agent loop, "judge" is too small a word.

The role is not only scoring answers. It is deciding tempo. It is deciding who comes in next. It is deciding whether the loop should narrow, split, pause, or continue. It is turning disagreement into a prompt that another PI agent can actually use.

That is closer to a conductor.

So I would call it the **Loop Conductor**.

Not because it is in charge of everything. It should not be. In v1 it should not execute commands, edit files, run migrations, or pretend to be the orchestrator of the whole universe.

Its job is more precise:

- read the PI agent views
- read the run state
- read the heartbeat
- find consensus
- name the tension
- mark risks
- choose the next PI agent
- write the next prompt
- define the stop condition

That is enough power. More than enough.

## The views I would start with

I would not start with ten agents. That is how people make orchestration look impressive and useless at the same time.

I would start with four PI views.

**Explorer** maps what is true. It reads files, artifacts, logs, previous decisions. Its job is not to solve the task. Its job is to say, "Here is the ground."

**Builder** looks for the smallest useful implementation step. It cares about how the change would actually be made, where the seams are, what to test first, and what not to touch.

**Critic** is there to make the loop less self-flattering. It asks what assumption is weak, what test is missing, what could regress, and where the plan is pretending certainty.

**Performance Sentinel** watches the loop itself. Is the heartbeat fresh? Has the same command repeated three times? Has nothing changed for twenty minutes? Is the task too broad for the current run?

Those four views do not need to agree. In fact, it is better when they do not.

Agreement tells the Loop Conductor what is safe. Disagreement tells it what the next prompt must resolve.

## The models are chosen by role

One important detail: a PI agent is not the same thing as a model.

The PI agent is the role. Explorer, Builder, Critic, Performance Sentinel, Loop Conductor. Those are responsibilities and artifact contracts.

The model is the engine you assign to that role for a run.

That means Looped PI Fusion should be able to use multiple LLMs in the same loop without making the whole thing weird. Explorer might run on a fast local model. Builder might run on a coding model. Critic might run on the strongest reasoning model available. Performance Sentinel can usually be cheap and fast because it is mostly reading heartbeat files and progress logs. The Loop Conductor should use the best synthesis model you can justify, because its output becomes the next prompt.

In PI, I would do this with a model roster and a role policy.

The roster says which models exist:

```text
fast-local
coder-local
reasoning-remote
```

The role policy says who gets what:

```text
Explorer -> fast-local
Builder -> coder-local
Critic -> reasoning-remote
Performance Sentinel -> fast-local
Loop Conductor -> reasoning-remote
```

If a model is not available, PI uses the fallback order and records that fact. That last part matters. The loop should not silently pretend the Critic used the strongest model if it actually fell back to a small local one. The artifact trail should say what happened.

So every Fusion round should include a `model-assignments.json` file. Not for ceremony. For auditability.

Later, when a prompt turns out weak, you can ask a very practical question: was the direction bad, or did we ask the wrong model to do the wrong job?

## Why this can reach Fable 5-level results

This is the part I should say plainly: I think this kind of harness is how you start getting Fable 5-level results from a system, even when no single model in the loop is Fable 5.

Not every task. Not by magic. But on real builder work: debugging, implementation planning, code review, research synthesis, test selection, and handoff writing.

The win comes from the harness, not just the model.

A single strong model can still rush, miss context, or overfit to its first framing. A PI Fusion loop forces the work through independent views before the next move is written. One role maps the ground. One role looks for the implementation path. One role attacks the plan. One role checks the health of the run. Then the Loop Conductor turns that disagreement into a prompt that can be executed and verified.

That can produce output that feels frontier-class because the system has changed the reasoning path. It is no longer one model trying to be explorer, builder, critic, operator, and reviewer at the same time.

This is why I do not want to describe Looped PI Fusion as "more agents". The ambitious claim is different: orchestration can upgrade the result. A good harness can make the loop perform above the apparent weight of its individual model calls.

For me, Fable 5-level does not mean benchmark equivalence on everything. It means a practical bar: the next move is sharp, grounded, testable, and hard to get from a single pass. If a local-heavy PI setup can reach that bar reliably on narrow workflows, that changes the cost and ownership story.

## What the artifacts look like

The whole point of PI agents is that the work is not trapped inside a chat transcript. A run leaves a trail.

A Looped PI Fusion run should sit inside the normal run folder:

```text
/docs/agent-runs/2026-06-15/
  2026-06-15-21-30-00-looped-pi-fusion/
    run.json
    heartbeat.json
    progress.log
    decisions.md
    handoff.md
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

That little `pi-fusion` folder is where the loop starts to become inspectable.

You can see what each role thought. You can see what the Loop Conductor kept, what it rejected, and what it turned into the next prompt. If the loop goes wrong later, you can walk backward and find the decision where it drifted.

That matters.

An autonomous system without artifacts is just vibes at speed.

## The Loop Conductor output

I want the Loop Conductor to produce two things:

1. A machine-readable decision.
2. A human-readable next prompt.

The decision is for the harness:

```json
{
  "status": "continue",
  "consensus": [
    "The implementation path is now clear enough to proceed."
  ],
  "tensions": [
    {
      "topic": "test depth",
      "stances": [
        {
          "pi_agent": "Builder",
          "stance": "Targeted tests are enough."
        },
        {
          "pi_agent": "Critic",
          "stance": "A regression test should be added before editing."
        }
      ]
    }
  ],
  "risk_flags": [
    "The previous run repeated the same failing command twice."
  ],
  "next_pi_agent": "Builder",
  "next_prompt": "Add the missing regression test first, then implement the smallest code change that makes it pass. Do not broaden scope. Record changed files and test output.",
  "evidence_required": [
    "Regression test output",
    "Changed file summary",
    "Any unresolved errors"
  ],
  "stop_condition": "The regression test passes and the Builder records verification evidence."
}
```

The prompt is for the next PI agent. It should be clean enough that the next role can run with it immediately.

No vague motivational mush. No "be careful". No giant prompt wall that tries to solve everything by intimidation.

Just:

- who should act next
- what they are trying to prove
- what they are allowed to touch
- what evidence they must produce
- when to stop

The boring bits are the product.

## A real loop example

Imagine the PI loop is trying to fix a flaky login test.

The Explorer says:

> The failure only appears in WebKit. The latest run timed out waiting for the session cookie. The auth helper changed last week.

The Builder says:

> The likely fix is in the test setup, not the login component. Add a wait around cookie persistence and rerun only the WebKit auth spec.

The Critic says:

> Do not hide the flake with a longer timeout. The test might be racing because the app redirects before the cookie is written. Prove the cookie exists before navigation.

The Performance Sentinel says:

> Healthy heartbeat, but the last two attempts reran the full suite and wasted time. Narrow the next step.

The Loop Conductor does not write code. It writes the next move:

> Send Builder into the worktree. Add instrumentation or a focused assertion proving whether the cookie exists before redirect. Do not increase global timeouts. Run only the WebKit auth spec. Stop when the focused test either passes twice or produces a clearer failure artifact.

That is a much better next prompt than "fix the flaky login test".

It is smaller. It is sharper. It carries the disagreement forward instead of flattening it away.

## This is not just spawning more agents

The lazy version of this idea is "use more agents".

That is not the point.

More agents can make things worse. They can duplicate work, argue in circles, or create a review pile big enough that the human becomes the bottleneck again.

Looped PI Fusion is not about agent count. It is about where the disagreement enters the loop.

If the disagreement happens after the code is written, it becomes review pain.

If the disagreement happens before the next prompt, it becomes direction.

That is the shift.

The Explorer, Builder, Critic, and Performance Sentinel are not four people in a meeting. They are four structured views of the same run state. The Loop Conductor is not a manager. It is a compression step that turns those views into one useful next action.

## Why PI agents are the right substrate

This works better with PI agents than with loose chat sessions because PI agents already care about memory outside the model.

A PI loop can have:

- a run id
- a worktree
- a heartbeat
- progress logs
- commands run
- test results
- decisions
- handoff notes
- artifacts

That means the Loop Conductor is not trying to synthesize vibes. It is reading state.

And because every view writes to disk, the system is replayable. You can ask why a prompt was generated. You can inspect the Critic view. You can see whether the Performance Sentinel marked the run slow. You can tell whether the Loop Conductor ignored a risk.

That is the difference between an autonomous loop and an auditable autonomous loop.

## V1 should stay humble

The temptation with this kind of thing is always to make the conductor more powerful.

Let it spawn agents. Let it kill runs. Let it retry. Let it move branches. Let it open pull requests. Let it do everything.

I would not start there.

V1 should be a Prompt Driver.

The Loop Conductor writes the next prompt. The PI loop executes it. Existing PI mechanics handle the rest.

That boundary matters because it keeps the system understandable. If a run goes wrong, you know whether the failure came from:

- the view agents
- the Loop Conductor decision
- the executing PI agent
- the verifier
- the heartbeat/stuck detector

Once that is working, you can give the Loop Conductor more authority carefully. But the first version should earn that authority by writing good prompts and good artifacts.

## The thing I like about it

The part I like most is that Looped PI Fusion does not make the loop feel more futuristic.

It makes it feel more accountable.

That is the real unlock with agents. Not that they can run while you sleep. That is table stakes. Cron jobs have been doing that forever.

The unlock is that they can run, leave evidence, get challenged, revise direction, and hand off to the next role without losing the thread.

PI agents make the loop durable.

Fusion makes the loop less narrow.

The Loop Conductor makes the next prompt worth trusting.

That is Looped PI Fusion: a loop that does not just keep going, but keeps asking whether the next move is actually the right one.
