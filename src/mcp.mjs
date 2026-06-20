import { loadConfig } from './config.mjs';
import { runFusion } from './fusion.mjs';
import {
  appendReport,
  checkWork,
  defaultMcpRoot,
  fuseReview,
  getStatus,
  nextInstruction,
  startLoop,
} from './mcp-connector.mjs';

export async function runMcpServer(options = {}) {
  const configPath = options.config || 'local-fusion.config.json';
  const rootDir = options.rootDir || defaultMcpRoot();
  const server = new McpStdioServer({
    name: 'local-fusion',
    version: '0.1.0',
    tools: buildTools(),
    handler: async (name, args) => {
      const config = await loadConfig(configPath);
      if (name === 'fusion_ask') {
        const question = requiredString(args?.question, 'question');
        const result = await runFusion(config, question);
        return args?.json === false ? result.final_answer : result;
      }
      if (name === 'looped_start') return startLoop(rootDir, args);
      if (name === 'looped_report') return appendReport(rootDir, args);
      if (name === 'looped_check_work') return checkWork(config, rootDir, args);
      if (name === 'looped_fuse_review') return fuseReview(config, rootDir, args);
      if (name === 'looped_next') return nextInstruction(config, rootDir, args);
      if (name === 'looped_status') return getStatus(rootDir, args);
      throw new Error(`Unknown tool: ${name}`);
    },
  });
  await server.start();
}

export class McpStdioServer {
  constructor({ name, version, tools, handler, input = process.stdin, output = process.stdout, log = process.stderr }) {
    this.name = name;
    this.version = version;
    this.tools = tools;
    this.handler = handler;
    this.input = input;
    this.output = output;
    this.log = log;
    this.buffer = Buffer.alloc(0);
    // Wire framing: 'ndjson' (the MCP stdio spec — newline-delimited JSON) or
    // 'lsp' (legacy Content-Length frames). Detected from the first bytes the
    // client sends so we reply in the same dialect. Defaults to the spec.
    this.framing = null;
  }

  async start() {
    this.input.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.drain().catch((error) => this.log.write(`local-fusion MCP error: ${error?.stack || error}\n`));
    });
    await new Promise((resolve) => this.input.on('end', resolve));
  }

  async drain() {
    while (true) {
      if (this.framing === null) {
        this.framing = detectFraming(this.buffer);
        if (this.framing === null) return; // need more bytes to decide
      }
      let body;
      if (this.framing === 'lsp') {
        const parsed = readFrame(this.buffer);
        if (!parsed) return;
        this.buffer = this.buffer.subarray(parsed.nextOffset);
        body = parsed.body;
      } else {
        const nl = this.buffer.indexOf(0x0a);
        if (nl === -1) return;
        body = this.buffer.subarray(0, nl).toString('utf8').trim();
        this.buffer = this.buffer.subarray(nl + 1);
        if (!body) continue; // skip blank lines between messages
      }
      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.sendError(null, -32700, `Parse error: ${error.message}`);
        continue;
      }
      await this.handleMessage(message);
    }
  }

  async handleMessage(message) {
    if (!message || message.jsonrpc !== '2.0') {
      return this.sendError(message?.id ?? null, -32600, 'Invalid JSON-RPC request');
    }
    // Notifications have no id; acknowledge none.
    if (message.id === undefined) return;

    try {
      if (message.method === 'initialize') {
        return this.sendResult(message.id, {
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: this.name, version: this.version },
        });
      }
      if (message.method === 'ping') return this.sendResult(message.id, {});
      if (message.method === 'tools/list') return this.sendResult(message.id, { tools: this.tools });
      if (message.method === 'tools/call') {
        const toolName = message.params?.name;
        const args = message.params?.arguments || {};
        const result = await this.handler(toolName, args);
        return this.sendResult(message.id, toolResult(result));
      }
      return this.sendError(message.id, -32601, `Method not found: ${message.method}`);
    } catch (error) {
      return this.sendResult(message.id, {
        isError: true,
        content: [{ type: 'text', text: error?.message || String(error) }],
      });
    }
  }

  sendResult(id, result) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  sendError(id, code, message) {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  write(payload) {
    const json = JSON.stringify(payload);
    if (this.framing === 'lsp') {
      this.output.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      // MCP stdio: one JSON object per line, no embedded newlines.
      this.output.write(`${json}\n`);
    }
  }
}

// Decide the wire dialect from the first bytes the client sends. Returns null
// while there is not yet enough data to commit to a choice.
export function detectFraming(buffer) {
  let i = 0;
  while (i < buffer.length && (buffer[i] === 0x20 || buffer[i] === 0x09 || buffer[i] === 0x0d || buffer[i] === 0x0a)) i++;
  if (i >= buffer.length) return null;
  const head = buffer.subarray(i, Math.min(i + 15, buffer.length)).toString('utf8');
  if (/^content-length:/i.test(head)) return 'lsp';
  // Could still grow into "Content-Length:" — wait for more bytes before deciding.
  if (head.length < 15 && 'content-length:'.startsWith(head.toLowerCase())) return null;
  return 'ndjson';
}

export function readFrame(buffer) {
  const sep = buffer.indexOf('\r\n\r\n');
  if (sep === -1) return null;
  const header = buffer.subarray(0, sep).toString('utf8');
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
  if (!match) throw new Error('MCP frame missing Content-Length header');
  const length = Number(match[1]);
  const bodyStart = sep + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;
  return { body: buffer.subarray(bodyStart, bodyEnd).toString('utf8'), nextOffset: bodyEnd };
}

export function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof value === 'object' && value !== null ? value : undefined,
  };
}

function buildTools() {
  return [
    {
      name: 'fusion_ask',
      description: 'Ask the local-fusion council one question. GLM/GPT/Kimi answer independently; judge+synthesizer return one answer plus disagreement trace.',
      inputSchema: objectSchema({
        question: { type: 'string', description: 'Question or instruction for the council.' },
        json: { type: 'boolean', description: 'Return the full structured trace. Defaults true.' },
      }, ['question']),
    },
    {
      name: 'looped_start',
      description: 'Start an Opus/Claude-Code execution loop. Returns the first executor prompt and records frozen acceptance criteria.',
      inputSchema: objectSchema({
        objective: { type: 'string' },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        run_id: { type: 'string' },
      }, ['objective']),
    },
    {
      name: 'looped_report',
      description: 'Report what Claude Code/Opus did after an execution phase: files, tests, blockers, assumptions, and evidence.',
      inputSchema: objectSchema({
        run_id: { type: 'string' },
        summary: { type: 'string' },
        changed_files: { type: 'array', items: { type: 'string' } },
        tests: { type: 'array', items: { type: 'string' } },
        tests_run: { type: 'array', items: { type: 'string' } },
        test_output: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        acceptance_status: { type: 'string' },
        raw_evidence: { type: 'string' },
      }, ['run_id', 'summary']),
    },
    {
      name: 'looped_check_work',
      description: 'Use the configured GPT checker to decide if Opus work is fully done, incomplete, blocked, or uncertain. This is a gate before fusion.',
      inputSchema: objectSchema({
        run_id: { type: 'string' },
        extra_evidence: { type: 'string' },
        report: { type: 'object' },
      }, ['run_id']),
    },
    {
      name: 'looped_fuse_review',
      description: 'Conditionally invoke local-fusion on the frozen build evidence plus checker findings when the checker is uncertain/high-risk.',
      inputSchema: objectSchema({
        run_id: { type: 'string' },
        question: { type: 'string' },
        report: { type: 'object' },
        check: { type: 'object' },
      }, ['run_id']),
    },
    {
      name: 'looped_next',
      description: 'Conductor synthesizes checker corrections and optional fusion review into one bounded next prompt for Claude Code/Opus, or marks complete.',
      inputSchema: objectSchema({
        run_id: { type: 'string' },
        report: { type: 'object' },
        check: { type: 'object' },
        fusion_review: { type: 'object' },
      }, ['run_id']),
    },
    {
      name: 'looped_status',
      description: 'Return current MCP loop state, latest checker result, latest conductor prompt, and artifact path.',
      inputSchema: objectSchema({ run_id: { type: 'string' } }, ['run_id']),
    },
  ];
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: true };
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
