#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { runFusion } from './fusion.mjs';
import { runLoopedFusion } from './looped.mjs';
import { createPiClient } from './pi-transport.mjs';
import { runMcpServer } from './mcp.mjs';

const command = process.argv[2];

if (command === '--version') {
  // Write to stdout and let the process drain and exit naturally; calling
  // process.exit(0) here can truncate piped output before the write flushes.
  process.stdout.write(`${readVersion()}\n`);
  process.exitCode = 0;
} else if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exitCode = 0;
} else {
  try {
    if (command === 'ask') {
      await ask(process.argv.slice(3));
    } else if (command === 'looped') {
      await looped(process.argv.slice(3));
    } else if (command === 'serve') {
      await serve(process.argv.slice(3));
    } else if (command === 'mcp') {
      await mcp(process.argv.slice(3));
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

function readVersion() {
  const pkgUrl = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(pkgUrl, 'utf8')).version;
}

async function ask(args) {
  const options = parseArgs(args);
  const prompt = options._.join(' ').trim() || await readStdin();
  const config = await loadConfig(options.config || 'local-fusion.config.json');
  const result = await runFusion(config, prompt);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.degradation_reasons?.length) {
      console.error(`Degraded: ${result.degradation_reasons.join(' | ')}`);
    }
    console.log(result.final_answer);
  }
}

async function looped(args) {
  const options = parseArgs(args);
  const objective = options._.join(' ').trim();
  if (!objective) {
    throw new Error('looped needs an objective: node src/cli.mjs looped "<objective>"');
  }
  const config = await loadConfig(options.config || 'local-fusion.config.json');
  if (!config.model_roster || !config.role_model_policy) {
    throw new Error('looped needs model_roster and role_model_policy in the config (see looped-fusion.config.json).');
  }
  const runDir = options.runDir || null;
  const runState = {
    loopStep: Number(options.step || 1),
    heartbeat: options.heartbeat || 'fresh',
    elapsed: options.elapsed,
    expected: options.expected,
    health: options.health,
    recentCommands: options.commands ? String(options.commands).split('|') : [],
    notes: options.notes,
  };

  const piClient = createPiClient({ timeoutMs: config.timeoutMs });
  const call = (modelConfig, messages) => chatViaPiSafe(piClient, modelConfig, messages, config.timeoutMs);
  try {
    const result = await runLoopedFusion(config, objective, runState, call, {
      runId: options.runId,
      runDir,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (piClient) await piClient.close();
  }
}

async function chatViaPiSafe(client, modelConfig, messages, timeoutMs) {
  if (modelConfig.backend === 'pi') {
    const { chatViaPi } = await import('./pi-transport.mjs');
    return chatViaPi(client, modelConfig, messages, { timeoutMs });
  }
  const { chatCompletion } = await import('./openai-compatible.mjs');
  return chatCompletion(modelConfig, messages, { timeoutMs });
}

async function mcp(args) {
  const options = parseArgs(args);
  await runMcpServer({
    config: options.config || 'local-fusion.config.json',
    rootDir: options.rootDir || options.runDir,
  });
}

async function serve(args) {
  const options = parseArgs(args);
  const port = Number(options.port || process.env.PORT || 8787);
  const configPath = options.config || 'local-fusion.config.json';
  const host = options.host || '127.0.0.1';

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        return sendJson(response, 404, { error: { message: 'Not found' } });
      }

      const body = await readJsonBody(request);
      const config = await loadConfig(configPath);
      const result = await runFusion(config, { messages: body.messages || [] });

      return sendJson(response, 200, {
        id: `local-fusion-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'local/fusion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: result.final_answer,
            },
          },
        ],
        local_fusion: result,
      });
    } catch (error) {
      return sendJson(response, 500, {
        error: {
          message: error?.message || String(error),
          type: 'local_fusion_error',
        },
      });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  console.error(`local-fusion listening on http://${host}:${port}`);
}

function parseArgs(args) {
  const options = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (!next || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      options._.push(arg);
    }
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload, null, 2));
}

function printHelp() {
  console.log(`local-fusion

Usage:
  node src/cli.mjs ask "Compare ridge, lasso, and elastic-net regression"
  node src/cli.mjs ask --json < prompt.txt
  node src/cli.mjs looped "<objective>" --runDir ./runs/last [--step 1]
  node src/cli.mjs serve --port 8787
  node src/cli.mjs mcp [--rootDir ./runs/mcp]

Options:
  --config <path>  Config file path. Default: local-fusion.config.json
  --json           Print the full Fusion JSON result for ask
  --runDir <path>  looped: directory to write the pi-fusion artifact trail into
  --step <n>       looped: current loop step (default 1)
  --runId <id>     looped: override the generated run id
  --rootDir <path> mcp: directory for file-backed run state. Default: ./runs/mcp
  --host <host>    Server host. Default: 127.0.0.1
  --port <port>    Server port. Default: 8787
`);
}
