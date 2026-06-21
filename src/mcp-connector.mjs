import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFusion } from './fusion.mjs';
import { extractJsonPayload } from './fusion.mjs';
import { chatCompletion } from './openai-compatible.mjs';
import { chatViaPi, createPiClient } from './pi-transport.mjs';

export const CHECK_STATUSES = ['done', 'incomplete', 'blocked', 'uncertain'];
export const ROUTES = ['stop', 'direct_retry', 'fusion_review', 'human'];

export function makeRunId(prefix = 'mcp-fusion') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${prefix}-${randomUUID().slice(0, 8)}`;
}

export function defaultMcpRoot() {
  return join(process.cwd(), 'runs', 'mcp');
}

export function statePath(rootDir, runId) {
  return join(rootDir || defaultMcpRoot(), runId, 'state.json');
}

export function artifactPath(rootDir, runId, name) {
  return join(rootDir || defaultMcpRoot(), runId, name);
}

export async function startLoop(rootDir, input = {}) {
  const objective = requiredString(input.objective, 'objective');
  const runId = input.run_id || makeRunId();
  const state = {
    schema_version: '1.0',
    run_id: runId,
    objective,
    acceptance_criteria: asStringArray(input.acceptance_criteria),
    created_at: new Date().toISOString(),
    reports: [],
    checks: [],
    fusion_reviews: [],
    conductor_outputs: [],
    status: 'started',
  };
  await saveState(rootDir, state);
  return {
    run_id: runId,
    status: state.status,
    next_prompt: renderInitialExecutorPrompt(state),
    state_path: statePath(rootDir, runId),
  };
}

export async function appendReport(rootDir, input = {}) {
  const runId = requiredString(input.run_id, 'run_id');
  const state = await loadState(rootDir, runId);
  const report = normalizeReport(input);
  state.reports.push(report);
  state.status = 'reported';
  state.updated_at = new Date().toISOString();
  await saveState(rootDir, state);
  await writeFile(artifactPath(rootDir, runId, `report-${state.reports.length}.json`), JSON.stringify(report, null, 2));
  return { run_id: runId, report_index: state.reports.length - 1, status: state.status };
}

export async function checkWork(config, rootDir, input = {}, options = {}) {
  const runId = requiredString(input.run_id, 'run_id');
  const state = await loadState(rootDir, runId);
  const report = input.report ? normalizeReport({ ...input.report, run_id: runId }) : latest(state.reports);
  if (!report) throw new Error(`No report found for run_id ${runId}; call looped_report first or pass report.`);

  const checker = resolveChecker(config);
  const raw = await callModel(config, checker, [
    { role: 'system', content: checker.system || CHECKER_SYSTEM },
    { role: 'user', content: buildCheckerPrompt(state, report, input.extra_evidence) },
  ], options);
  const parsed = parseCheckerOutput(raw);
  const check = {
    ...parsed,
    report_index: state.reports.length ? state.reports.length - 1 : null,
    raw_output: raw,
    created_at: new Date().toISOString(),
  };
  state.checks.push(check);
  state.status = routeToStatus(check.recommended_route);
  state.updated_at = new Date().toISOString();
  await saveState(rootDir, state);
  await writeFile(artifactPath(rootDir, runId, `check-${state.checks.length}.json`), JSON.stringify(check, null, 2));
  return { run_id: runId, check_index: state.checks.length - 1, check };
}

export async function fuseReview(config, rootDir, input = {}, options = {}) {
  const runId = requiredString(input.run_id, 'run_id');
  const state = await loadState(rootDir, runId);
  const report = input.report ? normalizeReport({ ...input.report, run_id: runId }) : latest(state.reports);
  const check = input.check || latest(state.checks);
  if (!report) throw new Error(`No report found for run_id ${runId}; call looped_report first or pass report.`);

  const prompt = buildFusionReviewPrompt(state, report, check, input.question);
  const result = await runFusion(config, prompt, options);
  const review = {
    created_at: new Date().toISOString(),
    report_index: state.reports.length ? state.reports.length - 1 : null,
    check_index: state.checks.length ? state.checks.length - 1 : null,
    fusion: result,
  };
  state.fusion_reviews.push(review);
  state.status = 'fusion_reviewed';
  state.updated_at = new Date().toISOString();
  await saveState(rootDir, state);
  await writeFile(artifactPath(rootDir, runId, `fusion-review-${state.fusion_reviews.length}.json`), JSON.stringify(review, null, 2));
  return { run_id: runId, review_index: state.fusion_reviews.length - 1, review };
}

export async function nextInstruction(config, rootDir, input = {}, options = {}) {
  const runId = requiredString(input.run_id, 'run_id');
  const state = await loadState(rootDir, runId);
  const report = input.report ? normalizeReport({ ...input.report, run_id: runId }) : latest(state.reports);
  const check = input.check || latest(state.checks);
  const fusionReview = input.fusion_review || latest(state.fusion_reviews);
  if (!report) {
    return {
      run_id: runId,
      status: 'continue',
      route: 'direct_retry',
      next_prompt: renderInitialExecutorPrompt(state),
      reason: 'No executor report has been recorded yet.',
    };
  }
  if (check?.recommended_route === 'stop' || check?.status === 'done') {
    const output = {
      run_id: runId,
      status: 'complete',
      route: 'stop',
      next_prompt: '',
      reason: check.handoff_reason || 'Checker judged the work complete.',
      check,
    };
    state.conductor_outputs.push({ ...output, created_at: new Date().toISOString() });
    state.status = 'complete';
    state.updated_at = new Date().toISOString();
    await saveState(rootDir, state);
    return output;
  }
  if (check?.recommended_route === 'human') {
    const output = {
      run_id: runId,
      status: 'pause_for_human',
      route: 'human',
      next_prompt: '',
      reason: check.handoff_reason || 'Checker requested human escalation.',
      check,
    };
    state.conductor_outputs.push({ ...output, created_at: new Date().toISOString() });
    state.status = 'pause_for_human';
    state.updated_at = new Date().toISOString();
    await saveState(rootDir, state);
    return output;
  }

  const conductor = resolveConductor(config);
  const raw = await callModel(config, conductor, [
    { role: 'system', content: conductor.system || CONDUCTOR_SYSTEM },
    { role: 'user', content: buildNextPromptInput(state, report, check, fusionReview) },
  ], options);
  const parsed = parseNextOutput(raw, state, check, fusionReview);
  const output = { ...parsed, run_id: runId, raw_output: raw };
  state.conductor_outputs.push({ ...output, created_at: new Date().toISOString() });
  state.status = output.status;
  state.updated_at = new Date().toISOString();
  await saveState(rootDir, state);
  await writeFile(artifactPath(rootDir, runId, `next-${state.conductor_outputs.length}.json`), JSON.stringify(output, null, 2));
  return output;
}

export async function getStatus(rootDir, input = {}) {
  const runId = requiredString(input.run_id, 'run_id');
  const state = await loadState(rootDir, runId);
  return {
    run_id: runId,
    status: state.status,
    objective: state.objective,
    reports: state.reports.length,
    checks: state.checks.length,
    fusion_reviews: state.fusion_reviews.length,
    conductor_outputs: state.conductor_outputs.length,
    latest_report: latest(state.reports) || null,
    latest_check: latest(state.checks) || null,
    latest_next: latest(state.conductor_outputs) || null,
    state_path: statePath(rootDir, runId),
  };
}

export function buildCheckerPrompt(state, report, extraEvidence) {
  return [
    `Objective: ${state.objective}`,
    '',
    'Acceptance criteria (frozen; do not invent extra criteria):',
    state.acceptance_criteria.length ? state.acceptance_criteria.map((x) => `- ${x}`).join('\n') : '- _(none supplied; explicitly flag uncertainty)_',
    '',
    'Executor report (treat as evidence, but challenge unverified claims):',
    JSON.stringify(report, null, 2),
    '',
    extraEvidence ? `Extra evidence:\n${String(extraEvidence)}` : '',
    '',
    'Return ONLY JSON with exactly these keys:',
    JSON.stringify(CHECKER_SCHEMA, null, 2),
    '',
    'Rules:',
    '- Every missing requirement, likely bug, and verification gap must cite evidence_used.',
    '- Do not execute or suggest broad rewrites. Assess whether the objective is fully done.',
    '- Prefer direct_retry for concrete fixable gaps; fusion_review only for uncertainty, ambiguity, or high-risk disagreement.',
  ].filter(Boolean).join('\n');
}

export function buildFusionReviewPrompt(state, report, check, question) {
  return [
    question || 'Review whether the executor work is actually complete and identify the smallest next correction prompt if it is not.',
    '',
    `Objective: ${state.objective}`,
    '',
    'Acceptance criteria:',
    state.acceptance_criteria.length ? state.acceptance_criteria.map((x) => `- ${x}`).join('\n') : '- _(none supplied)_',
    '',
    'Executor report:',
    JSON.stringify(report, null, 2),
    '',
    'Primary checker findings:',
    check ? JSON.stringify(check, null, 2) : '_(no checker output)_',
    '',
    'Instructions for panel members:',
    '- Review the same frozen evidence only; do not invent files or commands.',
    '- Cite evidence for every criticism.',
    '- Distinguish hard failures, unmet requirements, verification gaps, and polish.',
    '- If the checker is overreaching, say so clearly.',
  ].join('\n');
}

export function parseCheckerOutput(rawOutput) {
  const fallback = {
    status: 'uncertain',
    confidence: 0,
    missing_requirements: [],
    likely_bugs: [],
    verification_gaps: ['Checker did not return valid JSON.'],
    exact_next_actions: [],
    evidence_used: [],
    recommended_route: 'fusion_review',
    handoff_reason: 'Checker output was not valid JSON; fusion review is safer.',
  };
  let parsed;
  try {
    parsed = JSON.parse(extractJsonPayload(rawOutput));
  } catch {
    return fallback;
  }
  const status = CHECK_STATUSES.includes(parsed.status) ? parsed.status : 'uncertain';
  const route = ROUTES.includes(parsed.recommended_route) ? parsed.recommended_route : routeForCheck(status, normalizeConfidence(parsed.confidence));
  return {
    status,
    confidence: normalizeConfidence(parsed.confidence),
    missing_requirements: asStringArray(parsed.missing_requirements),
    likely_bugs: asStringArray(parsed.likely_bugs),
    verification_gaps: asStringArray(parsed.verification_gaps),
    exact_next_actions: asStringArray(parsed.exact_next_actions),
    evidence_used: asStringArray(parsed.evidence_used),
    recommended_route: route,
    handoff_reason: typeof parsed.handoff_reason === 'string' ? parsed.handoff_reason : '',
  };
}

export function parseNextOutput(rawOutput, state, check, fusionReview) {
  let parsed;
  try {
    parsed = JSON.parse(extractJsonPayload(rawOutput));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return fallbackNext(state, check, fusionReview, 'Conductor output was not valid JSON.');
  }
  const status = ['continue', 'complete', 'pause_for_human', 'blocked'].includes(parsed.status) ? parsed.status : 'continue';
  return {
    status,
    route: ROUTES.includes(parsed.route) ? parsed.route : (status === 'complete' ? 'stop' : 'direct_retry'),
    next_prompt: typeof parsed.next_prompt === 'string' ? parsed.next_prompt.trim() : '',
    corrections_included: asStringArray(parsed.corrections_included),
    evidence_required: asStringArray(parsed.evidence_required),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    stop_condition: typeof parsed.stop_condition === 'string' ? parsed.stop_condition : '',
  };
}

export function routeForCheck(status, confidence = 0) {
  if (status === 'done' && confidence >= 0.8) return 'stop';
  if (status === 'blocked') return 'human';
  if (status === 'uncertain' || confidence < 0.55) return 'fusion_review';
  return 'direct_retry';
}

export function normalizeReport(input = {}) {
  return {
    created_at: new Date().toISOString(),
    summary: requiredString(input.summary, 'summary'),
    changed_files: asStringArray(input.changed_files),
    tests: asStringArray(input.tests || input.tests_run),
    test_output: typeof input.test_output === 'string' ? input.test_output : '',
    blockers: asStringArray(input.blockers),
    assumptions: asStringArray(input.assumptions),
    acceptance_status: typeof input.acceptance_status === 'string' ? input.acceptance_status : '',
    raw_evidence: typeof input.raw_evidence === 'string' ? input.raw_evidence : '',
  };
}

export function renderInitialExecutorPrompt(state) {
  return [
    `Build objective: ${state.objective}`,
    '',
    'Acceptance criteria:',
    ...(state.acceptance_criteria.length ? state.acceptance_criteria.map((x) => `- ${x}`) : ['- Define and preserve concrete acceptance criteria before broad implementation.']),
    '',
    'Execute the smallest safe build phase. When done, call looped_report with: summary, changed_files, tests/tests_run, test_output, blockers, assumptions, acceptance_status, and raw_evidence.',
  ].join('\n');
}

async function loadState(rootDir, runId) {
  return JSON.parse(await readFile(statePath(rootDir, runId), 'utf8'));
}

async function saveState(rootDir, state) {
  const dir = join(rootDir || defaultMcpRoot(), state.run_id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function resolveChecker(config) {
  return config.checker || config.mcp_checker || config.synthesizer || config.judge;
}

function resolveConductor(config) {
  return config.conductor || config.mcp_conductor || config.synthesizer || config.judge;
}

async function callModel(config, modelConfig, messages, options = {}) {
  if (!modelConfig) throw new Error('No checker/conductor model configured. Add checker, mcp_checker, synthesizer, or judge.');
  if (options.call) return options.call(modelConfig, messages);
  if (modelConfig.backend === 'pi') {
    const client = options.piClient || createPiClient({ timeoutMs: config.timeoutMs });
    try {
      return await chatViaPi(client, modelConfig, messages, { timeoutMs: config.timeoutMs });
    } finally {
      if (!options.piClient) await client.close();
    }
  }
  return chatCompletion(modelConfig, messages, { timeoutMs: config.timeoutMs });
}

function buildNextPromptInput(state, report, check, fusionReview) {
  return [
    `Objective: ${state.objective}`,
    '',
    'Acceptance criteria:',
    state.acceptance_criteria.length ? state.acceptance_criteria.map((x) => `- ${x}`).join('\n') : '- _(none supplied)_',
    '',
    'Latest executor report:',
    JSON.stringify(report, null, 2),
    '',
    'Primary checker output:',
    check ? JSON.stringify(check, null, 2) : '_(none)_',
    '',
    'Fusion review:',
    fusionReview ? JSON.stringify({ final_answer: fusionReview.fusion?.final_answer, analysis: fusionReview.fusion?.analysis, degradation_reasons: fusionReview.fusion?.degradation_reasons }, null, 2) : '_(not invoked)_',
    '',
    'Return ONLY JSON with exactly these keys:',
    JSON.stringify(NEXT_SCHEMA, null, 2),
    '',
    'Rules:',
    '- If the work is complete, status=complete, route=stop, next_prompt="".',
    '- Otherwise write one minimal, directly executable prompt for Claude Code/Opus.',
    '- Include checker corrections and fusion findings, but do not broaden scope.',
    '- Require evidence: changed files, commands/tests run, and acceptance criteria proof.',
  ].join('\n');
}

function fallbackNext(state, check, fusionReview, reason) {
  const actions = check?.exact_next_actions?.length ? check.exact_next_actions : ['Resolve the checker/fusion findings and provide concrete evidence.'];
  const fusionText = fusionReview?.fusion?.final_answer ? `\n\nFusion review summary:\n${fusionReview.fusion.final_answer}` : '';
  return {
    status: 'continue',
    route: check?.recommended_route || 'direct_retry',
    next_prompt: [
      `Continue objective: ${state.objective}`,
      '',
      'Apply these corrections only:',
      ...actions.map((a) => `- ${a}`),
      fusionText,
      '',
      'When complete, report changed_files, tests run, test output, remaining blockers, and acceptance_status via looped_report.',
    ].join('\n'),
    corrections_included: actions,
    evidence_required: ['changed_files', 'tests/test_output', 'acceptance_status'],
    reason,
    stop_condition: 'Checker returns done with confidence >= 0.8 or human pauses the loop.',
  };
}

function routeToStatus(route) {
  if (route === 'stop') return 'complete';
  if (route === 'human') return 'pause_for_human';
  if (route === 'fusion_review') return 'needs_fusion_review';
  return 'needs_retry';
}

function latest(items) {
  return Array.isArray(items) && items.length ? items[items.length - 1] : null;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function asStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split('\n').map((x) => x.trim()).filter(Boolean);
  return [];
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Checkers frequently report confidence on a 0-100 scale (e.g. 89) even when the
// schema asks for 0-1. Naively clamping squashes everything >=1 to exactly 1.0,
// destroying the signal. Treat clearly-percentage values (>1.5, <=100) as a
// percentage; values just over 1 (e.g. 1.2) are overflow of a 0-1 scale and clamp.
export function normalizeConfidence(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1.5 && n <= 100) n /= 100;
  return Math.max(0, Math.min(1, n));
}

const CHECKER_SYSTEM = 'You are a senior completion checker. You do not execute code. You verify whether Claude Code/Opus fully completed the objective using only supplied evidence. Be conservative and calibrated: confidence is the probability that EVERY acceptance criterion is genuinely met with no remaining issues, as a decimal from 0 to 1. Unverified claims, "manual testing", missing automated tests, or untested assumptions must lower it. Reserve confidence above 0.8 for work where every criterion has direct evidence. Return strict JSON only.';
const CONDUCTOR_SYSTEM = 'You are the local-fusion loop conductor. You synthesize checker findings and optional multi-model fusion review into one minimal next instruction for Claude Code/Opus. Return strict JSON only.';

const CHECKER_SCHEMA = {
  status: 'done | incomplete | blocked | uncertain',
  confidence: '0.0-1.0 decimal; probability ALL criteria are truly met; be conservative, lower for unverified claims',
  missing_requirements: ['evidence-cited unmet acceptance criteria'],
  likely_bugs: ['evidence-cited likely defects'],
  verification_gaps: ['evidence-cited missing proof/tests'],
  exact_next_actions: ['bounded next actions for Opus'],
  evidence_used: ['specific report fields, files, commands, test output, or acceptance criteria'],
  recommended_route: 'stop | direct_retry | fusion_review | human',
  handoff_reason: 'one sentence',
};

const NEXT_SCHEMA = {
  status: 'continue | complete | pause_for_human | blocked',
  route: 'stop | direct_retry | fusion_review | human',
  next_prompt: 'directly executable prompt for Claude Code/Opus; empty when complete',
  corrections_included: ['checker/fusion corrections included in next_prompt'],
  evidence_required: ['what Opus must report next'],
  reason: 'why this next move',
  stop_condition: 'concrete condition for ending the loop',
};
