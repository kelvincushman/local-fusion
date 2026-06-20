// Pi-subscription transport.
//
// When a model config has `backend: "pi"`, local-fusion talks to a headless
// Pi subprocess (`pi --mode rpc --no-session`) instead of POSTing to an
// OpenAI-compatible URL. Pi owns the auth (including OAuth subscriptions like
// ChatGPT/Claude Pro), so local-fusion needs no API keys of its own for these
// models — it only spawns `pi`, which uses `~/.pi/agent/auth.json`.
//
// One Pi subprocess is shared across all pi-backend calls in a single
// `runFusion` run (panel + judge + synth); we switch models between calls with
// `set_model` and collect each reply from the streamed `text_delta` events.

import { spawn } from 'node:child_process';
import { LocalModelError } from './openai-compatible.mjs';

// Suppress tool use: Pi's coding agent has read/bash/edit/write active, and
// without this preamble a code-flavoured question tempts the model into
// exploring the repo (extra turns, nondeterministic, repo-grounded instead of
// independent). This keeps every panel member a single deterministic prose turn.
const NO_TOOL_PREAMBLE =
  'Answer directly from your own knowledge in prose only. Do NOT call any tools ' +
  '(read, bash, edit, write, grep, or any other) and do not inspect files. ' +
  'Output only the requested content, with no preamble or meta-commentary.';

export function buildPiPrompt(modelConfig, messages) {
  const system = String(modelConfig.system || '').trim();
  const user = messages
    .filter((message) => message?.role === 'user')
    .map((message) => stringifyContent(message.content))
    .join('\n')
    .trim();

  const parts = [NO_TOOL_PREAMBLE];
  if (system) parts.push(system);
  if (user) parts.push(user);
  return parts.join('\n\n');
}

export function needsPi(config) {
  const entries = [...(Array.isArray(config?.panel) ? config.panel : [])];
  if (config?.judge) entries.push(config.judge);
  if (config?.synthesizer) entries.push(config.synthesizer);
  return entries.some((entry) => entry && entry.backend === 'pi');
}

export async function chatViaPi(client, modelConfig, messages, options = {}) {
  if (!client) {
    throw new LocalModelError('pi backend selected but no pi client was provided');
  }
  const { provider, modelId } = modelConfig;
  if (!provider || !modelId) {
    throw new LocalModelError(
      `pi backend needs both "provider" and "modelId" (model ${modelConfig.name || modelConfig.model || '?'})`,
    );
  }
  const prompt = buildPiPrompt(modelConfig, messages);
  return client.ask({
    provider,
    modelId,
    prompt,
    timeoutMs: options.timeoutMs,
  });
}

export function createPiClient(options = {}) {
  const defaultTimeoutMs = options.timeoutMs ?? 120000;
  const proc = spawn('pi', ['--mode', 'rpc', '--no-session'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderrBuf = '';
  let spawnError = null;
  let closed = false;
  const pending = new Map();
  const listeners = [];
  let nextId = 1;

  const failAll = (message) => {
    for (const [, entry] of pending) entry.reject(new LocalModelError(message));
    pending.clear();
  };

  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      for (const fn of [...listeners]) {
        try {
          fn(obj);
        } catch {
          // listener errors must not break the stream
        }
      }
      if (obj.type === 'response' && obj.id && pending.has(obj.id)) {
        const entry = pending.get(obj.id);
        pending.delete(obj.id);
        entry.resolve(obj);
      }
    }
  });

  proc.on('error', (error) => {
    spawnError = error;
    failAll(`pi rpc subprocess failed to start: ${error.message}`);
  });

  proc.on('exit', (code) => {
    if (closed) return;
    failAll(`pi rpc subprocess exited unexpectedly (code ${code})`);
  });

  function send(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (spawnError) {
        reject(new LocalModelError(`pi rpc unavailable: ${spawnError.message}`));
        return;
      }
      const id = String(nextId++);
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new LocalModelError(`pi rpc "${cmd.type}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      pending.set(id, {
        resolve: (obj) => {
          clearTimeout(timer);
          resolve(obj);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new LocalModelError(`pi rpc write failed: ${error.message}`));
      }
    });
  }

  function waitForEvent(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const handler = (obj) => {
        if (predicate(obj)) {
          detach();
          clearTimeout(timer);
          resolve(obj);
        }
      };
      const detach = () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
      listeners.push(handler);
      const timer = setTimeout(() => {
        detach();
        reject(new LocalModelError(`pi rpc event wait timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  // One Pi subprocess serves every pi-backend call in a run. Its JSONL stdin/stdout
  // can only carry one command at a time, so serialize asks even if the caller
  // requested a parallel panel — they simply run back-to-back over one pipe.
  let tail = Promise.resolve();
  const serialize = (task) => {
    const result = tail.then(task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  async function askRaw({ provider, modelId, prompt, timeoutMs }) {
    if (closed) throw new LocalModelError('pi client is closed');
    if (spawnError) throw new LocalModelError(`pi rpc unavailable: ${spawnError.message}`);
    const callTimeout = timeoutMs ?? defaultTimeoutMs;

    const setResp = await send({ type: 'set_model', provider, modelId }, callTimeout);
    if (!setResp.success) {
      throw new LocalModelError(
        `pi set_model failed for ${provider}/${modelId}: ${setResp.error || 'unknown error'}`,
      );
    }

    let text = '';
    let toolCalls = 0;
    let lastAssistant = null;
    const collector = (obj) => {
      if (obj.type === 'message_update' && obj.assistantMessageEvent?.type === 'text_delta') {
        text += obj.assistantMessageEvent.delta;
      }
      if (obj.type === 'tool_execution_start') {
        toolCalls += 1;
      }
      if (obj.type === 'message_end' && obj.message?.role === 'assistant') {
        lastAssistant = obj.message;
      }
    };
    listeners.push(collector);

    const promptRespPromise = send({ type: 'prompt', message: prompt }, callTimeout);
    try {
      await waitForEvent((obj) => obj.type === 'agent_end', callTimeout);
      const promptResp = await promptRespPromise;
      if (promptResp.success === false) {
        throw new LocalModelError(`pi prompt rejected: ${promptResp.error || 'unknown error'}`);
      }
    } finally {
      const index = listeners.indexOf(collector);
      if (index >= 0) listeners.splice(index, 1);
    }

    if (lastAssistant && (lastAssistant.stopReason === 'error' || lastAssistant.errorMessage)) {
      throw new LocalModelError(
        `pi rpc ${provider}/${modelId} returned an error: ${lastAssistant.errorMessage || lastAssistant.stopReason}`,
      );
    }

    let trimmed = text.trim();
    if (!trimmed && Array.isArray(lastAssistant?.content)) {
      trimmed = lastAssistant.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text || '')
        .join('\n')
        .trim();
    }
    if (!trimmed) {
      const leakNote = toolCalls ? ` (${toolCalls} tool call(s) leaked despite preamble)` : '';
      throw new LocalModelError(`pi rpc returned no text for ${provider}/${modelId}${leakNote}`);
    }
    return trimmed;
  }

  return {
    ask: (args) => serialize(() => askRaw(args)),

    close: async () => {
      if (closed) return;
      closed = true;
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        proc.kill('SIGTERM');
      } catch {
        // process may already be gone
      }
    },

    _stderr: () => stderrBuf,
  };
}

function stringifyContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('\n');
  }
  return '';
}
