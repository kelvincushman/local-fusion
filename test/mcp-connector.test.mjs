import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendReport,
  checkWork,
  fuseReview,
  getStatus,
  nextInstruction,
  parseCheckerOutput,
  routeForCheck,
  startLoop,
} from '../src/mcp-connector.mjs';
import { detectFraming, readFrame, toolResult } from '../src/mcp.mjs';

const CONFIG = {
  checker: { name: 'checker', model: 'fake' },
  conductor: { name: 'conductor', model: 'fake' },
  panel: [{ name: 'p1', model: 'fake' }],
  judge: { name: 'judge', model: 'fake' },
  synthesizer: { name: 'synth', model: 'fake' },
};

test('checker routing maps done/high-confidence to stop and uncertain to fusion', () => {
  assert.equal(routeForCheck('done', 0.9), 'stop');
  assert.equal(routeForCheck('done', 0.3), 'fusion_review');
  assert.equal(routeForCheck('incomplete', 0.8), 'direct_retry');
  assert.equal(routeForCheck('uncertain', 0.9), 'fusion_review');
  assert.equal(routeForCheck('blocked', 0.9), 'human');
});

test('parseCheckerOutput normalizes malformed and valid checker JSON', () => {
  const malformed = parseCheckerOutput('not json');
  assert.equal(malformed.status, 'uncertain');
  assert.equal(malformed.recommended_route, 'fusion_review');

  const valid = parseCheckerOutput(JSON.stringify({
    status: 'done',
    confidence: 1.2,
    missing_requirements: [''],
    likely_bugs: ['none'],
    verification_gaps: [],
    exact_next_actions: [],
    evidence_used: ['tests passed'],
    recommended_route: 'stop',
  }));
  assert.equal(valid.status, 'done');
  assert.equal(valid.confidence, 1);
  assert.deepEqual(valid.likely_bugs, ['none']);
});

test('file-backed loop stores reports, checks, and stop decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-loop-'));
  const started = await startLoop(root, {
    objective: 'build feature',
    acceptance_criteria: ['tests pass'],
    run_id: 'run-1',
  });
  assert.equal(started.run_id, 'run-1');
  assert.match(started.next_prompt, /Build objective/);

  await appendReport(root, {
    run_id: 'run-1',
    summary: 'implemented feature',
    changed_files: ['src/a.js'],
    tests: ['node --test'],
    test_output: 'ok',
    acceptance_status: 'tests pass',
  });

  const checked = await checkWork(CONFIG, root, { run_id: 'run-1' }, {
    call: async () => JSON.stringify({
      status: 'done',
      confidence: 0.93,
      missing_requirements: [],
      likely_bugs: [],
      verification_gaps: [],
      exact_next_actions: [],
      evidence_used: ['test_output ok'],
      recommended_route: 'stop',
      handoff_reason: 'All criteria satisfied.',
    }),
  });
  assert.equal(checked.check.status, 'done');

  const next = await nextInstruction(CONFIG, root, { run_id: 'run-1' }, {
    call: async () => { throw new Error('conductor should not run when checker says stop'); },
  });
  assert.equal(next.status, 'complete');
  assert.equal(next.next_prompt, '');

  const status = await getStatus(root, { run_id: 'run-1' });
  assert.equal(status.status, 'complete');
  assert.equal(status.reports, 1);
  assert.equal(status.checks, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'run-1', 'state.json'), 'utf8')).status, 'complete');
});

test('looped_next synthesizes correction prompt when checker requests retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-next-'));
  await startLoop(root, { objective: 'fix bug', run_id: 'run-2' });
  await appendReport(root, { run_id: 'run-2', summary: 'partial', blockers: [], changed_files: [] });
  await checkWork(CONFIG, root, { run_id: 'run-2' }, {
    call: async () => JSON.stringify({
      status: 'incomplete',
      confidence: 0.8,
      missing_requirements: ['no regression test'],
      likely_bugs: [],
      verification_gaps: ['tests not run'],
      exact_next_actions: ['Add regression test', 'Run node --test'],
      evidence_used: ['report.tests empty'],
      recommended_route: 'direct_retry',
      handoff_reason: 'Needs proof.',
    }),
  });
  const next = await nextInstruction(CONFIG, root, { run_id: 'run-2' }, {
    call: async () => JSON.stringify({
      status: 'continue',
      route: 'direct_retry',
      next_prompt: 'Add regression test and run node --test. Report evidence.',
      corrections_included: ['no regression test', 'tests not run'],
      evidence_required: ['test output'],
      reason: 'Checker found missing proof.',
      stop_condition: 'test passes',
    }),
  });
  assert.equal(next.status, 'continue');
  assert.match(next.next_prompt, /regression test/);
});

test('MCP frame parser and tool result shape', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const parsed = readFrame(framed);
  assert.equal(parsed.body, body);
  assert.equal(parsed.nextOffset, framed.length);

  const result = toolResult({ ok: true });
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(result.structuredContent, { ok: true });
});

test('detectFraming distinguishes MCP newline-delimited JSON from legacy Content-Length', () => {
  // The MCP stdio spec (what Claude Code speaks) is newline-delimited JSON.
  assert.equal(detectFraming(Buffer.from('{"jsonrpc":"2.0"}\n')), 'ndjson');
  assert.equal(detectFraming(Buffer.from('Content-Length: 42\r\n\r\n{}')), 'lsp');
  assert.equal(detectFraming(Buffer.from('content-length: 42\r\n\r\n{}')), 'lsp');
  // Leading whitespace must not break detection.
  assert.equal(detectFraming(Buffer.from('\n  {"id":1}\n')), 'ndjson');
  // Too few bytes to commit (could still grow into "Content-Length:").
  assert.equal(detectFraming(Buffer.from('Content-')), null);
  assert.equal(detectFraming(Buffer.from('   ')), null);
});

test('McpStdioServer answers newline-delimited initialize/tools-list (Claude Code transport)', async () => {
  const { McpStdioServer } = await import('../src/mcp.mjs');
  const { Readable, Writable } = await import('node:stream');
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const input = Readable.from([`${init}\n${list}\n`]);
  let out = '';
  const output = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
  const server = new McpStdioServer({
    name: 'test', version: '0', tools: [{ name: 'demo' }],
    handler: async () => ({ ok: true }), input, output,
  });
  await server.start();
  const lines = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.serverInfo.name, 'test');
  assert.deepEqual(lines[1].result.tools, [{ name: 'demo' }]);
  assert.ok(!out.includes('Content-Length'), 'must reply in newline-delimited dialect');
});

test('fuseReview persists local-fusion output with injected piClient/call options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-fuse-'));
  await startLoop(root, { objective: 'decide', run_id: 'run-3' });
  await appendReport(root, { run_id: 'run-3', summary: 'ambiguous' });
  const cfg = {
    panel: [{ name: 'panel-a', model: 'fake' }],
    judge: { name: 'judge', model: 'fake' },
    synthesizer: { name: 'synth', model: 'fake' },
  };
  let calls = 0;
  const review = await fuseReview(cfg, root, { run_id: 'run-3' }, {
    piClient: null,
    call: async (modelConfig, messages) => {
      calls += 1;
      if (modelConfig.name === 'judge') return JSON.stringify({ consensus: ['c'], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [], judge_notes: [] });
      if (modelConfig.name === 'synth') return 'final answer';
      return `panel saw ${messages.at(-1).content}`;
    },
  });
  assert.equal(review.review.fusion.status, 'ok');
  assert.equal(review.review.fusion.final_answer, 'final answer');
  assert.ok(calls >= 3);
});
