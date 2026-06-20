# The Models I Already Paid For

## How I wired my Pi subscriptions into a local Fusion council without buying a single API key

There is a particular kind of frustration that comes from paying for something twice. I pay for ChatGPT. I pay for Claude. I have a ZAI key and a Kimi Code subscription. My Pi agent harness uses all of them, happily, every day. And then I sat down to build a local Fusion council — the OpenRouter trick where several models answer the same prompt, a judge compares them, and a synthesizer writes one final answer — and discovered that my local runner could not reach a single one of the models I was already paying for.

That's the story. Not how I bolted models onto a config file. How I found out that a "subscription" and an "API key" are not the same product, why every provider has quietly walled its best models off from anything that isn't a blessed coding agent, and the small, satisfying trick that fixed it: stop trying to call the models myself, and make my coding-agent harness call them for me.

## Subscriptions are not API keys

I should have known this. I did know this, somewhere in the back of my head, and I still walked into it.

local-fusion is a tiny, dependency-free runner. Node on one side, Python on the other, behaviour-matched. It does one network thing: it POSTs to an OpenAI-compatible `/chat/completions` endpoint and reads `choices[0].message.content`. That is the entire transport. It is deliberately, almost stubbornly, local-only.

So the question was: where do I point it?

The first answer was "at the providers." That died immediately, three different ways, one per model.

GPT-5.4, which I reach through Pi's `openai-codex` provider, is not on `api.openai.com`. It lives at `chatgpt.com/backend-api`. That is the Codex subscription backend. It does not accept an API key at all. It accepts an OAuth token that Pi obtains and refreshes through a login flow local-fusion has no part in. There is no string I can put in a config file that reaches it.

Claude Opus was the second wall. Anthropic's native API is a different shape entirely — `/v1/messages`, `x-api-key` header, `content[].text` response — not the OpenAI shape local-fusion speaks. Worse, the access I have is a Claude Pro/Max OAuth token, not an `sk-ant-` API key. Even if I wanted to write the Anthropic transport, I had no key to write it with.

GLM was the one that worked. ZAI exposes an honest OpenAI-compatible endpoint and a real API key. So for about an hour my "three-model council" was one model under three hats, which is not a council. It is test-time compute wearing a costume.

I was about to give up and tell myself the real answer was API keys. Buy the Anthropic key. Buy the OpenAI key. Run LiteLLM. Let a proxy translate the shapes. That is the orthodox move, and it is correct, and it is also the moment you start paying for the same intelligence a second time.

I did not want to do that.

## The wall is the product

Here is the part that took me too long to internalise. The providers are not being lazy or hostile by gating their models behind approved clients. The wall *is* the product.

Read the Kimi Code error I got when I tried to call it directly, with the key I literally paid for:

> Kimi For Coding is currently only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code, Kilo Code, etc.

`access_terminated_error`. The key was valid. The endpoint was correct. The request was well-formed. It was rejected because the caller did not smell like a coding agent. The same gate is why Codex lives on a subscription backend and not the public API, and why Anthropic bills third-party-harness usage against a separate "extra usage" budget instead of your plan limits.

The pattern is consistent across every frontier provider right now: the good models are increasingly sold as *access through a blessed harness*, not as raw API calls. The price of the subscription is the price of being a blessed caller.

So the question flipped. I had been asking, "how do I make local-fusion reach these models?" The right question was: "who is already a blessed caller that I control?"

The answer was Pi. Pi is the coding agent. Pi is already authenticated. Pi already refreshes the OAuth tokens. Pi already speaks every one of these shapes — `openai-completions`, `anthropic-messages`, the ZAI thinking format, the Kimi gate. I just needed local-fusion to stop calling the models and start calling Pi.

## Making the harness the backend

Pi has a headless mode: `pi --mode rpc --no-session`. It speaks JSON over stdin and stdout. You send it a command, it streams events back. It is meant for embedding Pi in editors and other UIs. It is also, as it turns out, exactly the bridge I needed.

So I added a second transport to local-fusion. The original transport POSTs to a URL. The new one, `backend: "pi"`, spawns one persistent headless Pi subprocess, and for each council member it sends `set_model` then `prompt`, then collects the streamed `text_delta` events into a string. Five calls — three panel, one judge, one synth — all through the single Pi process that already holds my subscriptions. local-fusion never sees an API key. It never even sees a URL. It just talks to Pi, and Pi talks to the frontier.

The config went from a list of endpoints and keys to a list of roles:

```jsonc
{
  "panel": [
    { "backend": "pi", "provider": "zai",           "modelId": "glm-5.2",            "system": "generalist" },
    { "backend": "pi", "provider": "openai-codex", "modelId": "gpt-5.4",            "system": "implementer" },
    { "backend": "pi", "provider": "kimi-coding",  "modelId": "kimi-k2-thinking", "system": "critic" }
  ],
  "judge":       { "backend": "pi", "provider": "kimi-coding",  "modelId": "kimi-k2-thinking" },
  "synthesizer": { "backend": "pi", "provider": "openai-codex", "modelId": "gpt-5.4" }
}
```

No keys in that file. No URLs. Just roles and the Pi identities I already logged in once.

## What broke, in order

The clean version of this post would stop there. The honest version lists the things that broke, because every one of them was a real lesson.

First: Pi is a coding agent, which means it has tools loaded — read, bash, edit, write. The first time I asked the panel a code-flavoured question, the model ignored my prompt and started exploring the repo. It called `read`, opened `src/fusion.mjs`, and gave me a grounded answer about the actual file on disk. That is a great feature of a coding agent and a disaster for a Fusion panel, where each member is supposed to answer independently from its own knowledge. I had to prepend a no-tool preamble to every prompt — *answer from your own knowledge, in prose, do not call any tools* — to drag the models back into being panellists instead of investigators.

Second: one Pi subprocess, one stdin pipe. The obvious move was to run the panel in parallel, three models at once. But there is no multiplexing on that pipe. Three concurrent `set_model` and `prompt` lines on one stdin corrupt the id-to-response correlation instantly. So I serialised the asks inside the client, even when the config says parallel. They run back-to-back through one pipe. Slower, correct.

Third: the Opus failure that was not a bug. Opus came back empty. My first code said "returned no text," which was useless. When I instrumented the events, the real error was an HTTP 400 from Anthropic: *Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.* To prove it was an account-level budget wall and not my transport, I swapped Opus for Haiku — the cheapest Anthropic model — and got the byte-for-byte identical error. The authentication was fine. The separate pay-as-you-go budget behind it was empty. I fixed the code to surface the real error per model instead of hiding it, and I swapped Opus out of the default council until I fund that budget. That is a billing problem, not a code problem, and I would rather have the council work today with three models than wait on a fourth.

Fourth, and my favourite: the bug that was already there. Adding the Pi path to the Python implementation surfaced a latent `KeyError`. The panel dispatcher did `model.get("name", model["model"])`, and Python evaluates that default argument eagerly — so any entry that had a `name` but no `model` (which is exactly what a `pi` entry looks like) blew up before the `.get` could do its job. The Node version used `||` and short-circuited correctly, so nobody had ever noticed. The new feature found an old bug. That is the best reason I know to add a second transport to a codebase: it stresses the seams you stopped seeing.

## The council that runs today

Right now the default config is a three-model council, all through Pi, none of them requiring an API key I did not already have: GLM-5.2 as the careful generalist, GPT-5.4 as the precise implementer, Kimi K2 Thinking as the sceptical critic, Kimi as judge, GPT-5.4 as synthesiser. Five calls per question. About fifty seconds. Real judge output — consensus, contradictions, blind spots — not a merge.

Opus comes back the moment I add extra-usage budget. Kimi K2 was the surprise: it only works through Pi, full stop, because of the coding-agent gate, and it is excellent. The piece I was sure would be the hard one — the OAuth backends — turned out to be the easy one, and the piece I assumed would be trivial — Kimi, which advertises an OpenAI-compatible endpoint — turned out to be the one that absolutely required the harness-as-bridge trick.

## The boring lesson

The interesting part of this build was not the code. The code is small. The interesting part was admitting that the providers have quietly redefined what a "model" is. A model is no longer a thing you call. A model is a thing your blessed harness calls on your behalf, and the harness *is* the credential now.

Once I accepted that, the whole architecture got simpler. local-fusion does not need to speak Anthropic's wire format. It does not need to implement OAuth. It does not need a proxy, or a translation layer, or a second set of keys. It just needs to be a good client of the one process that already solved all of that.

My subscriptions were already paid for. I just had to stop trying to reach past the harness that earned them.
