import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAssignments,
  parseDecision,
  buildViewPrompt,
  buildConductorPrompt,
  runLoopedFusion,
  VIEW_ROLES,
} from '../src/looped.mjs';

const ROSTER = {
  glm52: { provider: 'zai', modelId: 'glm-5.2', kind: 'local' },
  gpt54: { provider: 'openai-codex', modelId: 'gpt-5.4', kind: 'remote' },
  kimi: { provider: 'kimi-coding', modelId: 'kimi-k2-thinking', kind: 'local' },
};
const POLICY = {
  Explorer: { preferred: 'glm52', fallback_order: ['kimi'], reason: 'fast' },
  Builder: { preferred: 'gpt54', fallback_order: ['kimi'], reason: 'coder' },
  Critic: { preferred: 'kimi', fallback_order: ['gpt54'], reason: 'adversarial' },
  'Performance Sentinel': { preferred: 'glm52', fallback_order: ['kimi'], reason: 'cheap' },
  'Loop Conductor': { preferred: 'gpt54', fallback_order: ['kimi'], reason: 'synthesis' },
};

test('resolveAssignments assigns every role, falling back when preferred is missing', () => {
  const roster = { ...ROSTER, gpt54: undefined };
  delete roster.gpt54;
  const assignments = resolveAssignments(roster, POLICY);
  const byRole = Object.fromEntries(assignments.map((a) => [a.pi_agent, a]));
  assert.equal(byRole.Builder.model_id, 'kimi');
  assert.equal(byRole.Builder.fallback, true);
  assert.equal(byRole['Loop Conductor']?.model_id, 'kimi');
  assert.equal(assignments.length, 5);
});

test('parseDecision accepts valid JSON and coerces defaults for unknown status/agent', () => {
  const assignments = resolveAssignments(ROSTER, POLICY);
  const raw = JSON.stringify({
    status: 'bogus',
    next_pi_agent: 'Wizard',
    next_model_id: 'gpt54',
    next_prompt: 'do the thing',
    evidence_required: ['out'],
    stop_condition: 'done',
    handoff_reason: 'because',
    consensus: ['c'],
    tensions: [],
    risk_flags: [],
  });
  const result = parseDecision(raw, assignments, 'run-1');
  assert.equal(result.ok, true);
  assert.equal(result.decision.status, 'continue', 'unknown status defaults to continue');
  assert.equal(result.decision.next_pi_agent, 'Builder', 'unknown agent defaults to Builder');
  assert.ok(result.notes.length >= 2, 'parser records both coercions as notes');
});

test('parseDecision rejects out-of-roster next_model_id and flags it as a risk', () => {
  const assignments = resolveAssignments(ROSTER, POLICY);
  const raw = JSON.stringify({
    status: 'continue',
    next_pi_agent: 'Builder',
    next_model_id: 'claude-haiku-4-5',
    next_prompt: 'do it',
    evidence_required: [],
    stop_condition: 'done',
    handoff_reason: 'r',
    consensus: [],
    tensions: [],
    risk_flags: [],
  });
  const result = parseDecision(raw, assignments, 'run-1');
  assert.equal(result.ok, true);
  assert.equal(result.decision.next_model_id, null);
  assert.ok(result.decision.risk_flags.some((r) => r.includes('claude-haiku-4-5')));
});

test('parseDecision fails on missing next_prompt', () => {
  const assignments = resolveAssignments(ROSTER, POLICY);
  const raw = JSON.stringify({ status: 'continue', next_pi_agent: 'Builder', next_model_id: 'gpt54' });
  const result = parseDecision(raw, assignments, 'run-1');
  assert.equal(result.ok, false);
});

test('runLoopedFusion runs 4 views + conductor, writes all 7 PRD artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'looped-test-'));
  const call = async (modelConfig, messages) => {
    const system = messages[0].content;
    if (system.startsWith('You are the Loop Conductor')) {
      return JSON.stringify({
        status: 'continue',
        next_pi_agent: 'Builder',
        next_model_id: 'gpt54',
        next_prompt: 'Implement X. Do not broaden scope.',
        evidence_required: ['test output'],
        stop_condition: 'test passes',
        handoff_reason: 'surface is clear',
        consensus: ['surface is clear'],
        tensions: [],
        risk_flags: [],
      });
    }
    return `view content from ${modelConfig.name}`;
  };

  const result = await runLoopedFusion(
    { model_roster: ROSTER, role_model_policy: POLICY },
    'objective',
    { loopStep: 1 },
    call,
    { runDir: dir },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.views.length, 4);
  assert.deepEqual(result.views.map((v) => v.role).sort(), [...VIEW_ROLES].sort());
  assert.equal(result.decision.next_pi_agent, 'Builder');
  assert.equal(result.view_errors.length, 0);

  const files = new Set(readdirSync(join(dir, 'artifacts', 'pi-fusion')));
  for (const expected of [
    'model-assignments.json',
    'explorer-view.md',
    'builder-view.md',
    'critic-view.md',
    'performance-sentinel-view.md',
    'loop-conductor-decision.json',
    'loop-conductor-prompt.md',
    'loop-conductor-summary.md',
  ]) {
    assert.ok(files.has(expected), `missing artifact: ${expected}`);
  }
  const writtenDecision = JSON.parse(readFileSync(join(dir, 'artifacts', 'pi-fusion', 'loop-conductor-decision.json'), 'utf8'));
  assert.equal(writtenDecision.next_prompt, 'Implement X. Do not broaden scope.');
});

test('runLoopedFusion aborts when fewer than 2 views succeed (PRD error handling)', async () => {
  const call = async () => { throw new Error('boom'); };
  const result = await runLoopedFusion(
    { model_roster: ROSTER, role_model_policy: POLICY },
    'objective',
    { loopStep: 1 },
    call,
    { runDir: null },
  );
  assert.equal(result.status, 'error');
  assert.equal(result.views.length, 0);
  assert.match(result.summary, /Aborted.*0\/4 views/);
});

test('buildViewPrompt and buildConductorPrompt embed objective and run-state', () => {
  const vp = buildViewPrompt('Critic', 'ship feature X', { loopStep: 3, heartbeat: 'stale' });
  assert.match(vp, /ship feature X/);
  assert.match(vp, /loop step: 3/i);
  assert.match(vp, /stale/);
  const assignments = resolveAssignments(ROSTER, POLICY);
  const cp = buildConductorPrompt('obj', { loopStep: 1 }, [{ role: 'Critic', content: 'risky' }], assignments);
  assert.match(cp, /Return ONLY the JSON object/);
  assert.match(cp, /risky/);
});
