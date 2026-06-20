// Looped PI Fusion — a Prompt Driver layer over the agent loop.
//
// Implements docs/prd-pi-agent-fusion-loop.md. Per run:
//   1. resolve model assignments for the 4 view roles + Conductor from a roster
//   2. dispatch Explorer / Builder / Critic / Performance Sentinel views
//      (each is a single role-specialized council call via the existing transport)
//   3. Loop Conductor reads views + run-state snapshot, emits decision JSON
//   4. write the artifact trail under <runDir>/artifacts/pi-fusion/
//   5. return { decision, prompt, summary } for the caller to inject
//
// V1 is a Prompt Driver only (per PRD Non-Goals): this module never executes
// shell, edits files, or runs tests. It writes artifacts and produces a next
// prompt. The agent loop owns execution.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractJsonPayload } from './fusion.mjs';

export const VIEW_ROLES = ['Explorer', 'Builder', 'Critic', 'Performance Sentinel'];
export const ALL_ROLES = [...VIEW_ROLES, 'Loop Conductor'];
export const VALID_STATUSES = ['continue', 'split', 'pause_for_human', 'possibly_stuck', 'complete'];

// ---- Role prompts -------------------------------------------------------

const VIEW_SYSTEMS = {
  Explorer:
    'You are the Explorer in a PI Fusion loop. Map what is actually true on the ground: relevant files, symbols, docs, current shape, facts vs assumptions, unknowns the next prompt must resolve. Do not propose code.',
  Builder:
    'You are the Builder in a PI Fusion loop. Identify the smallest safe implementation step: likely change shape, seams, what to touch, what not to touch, dependencies, implementation risks.',
  Critic:
    'You are the Critic in a PI Fusion loop. Challenge the direction before the loop commits: hidden assumptions, likely failure modes, missing tests, reasons the next step may be wrong.',
  'Performance Sentinel':
    'You are the Performance Sentinel in a PI Fusion loop. Read loop health from the run-state snapshot: heartbeat freshness, elapsed vs expected time, repeated commands or no-progress, and recommend a health verdict: healthy | slow | possibly_stuck | needs_split.',
};

const CONDUCTOR_SYSTEM =
  'You are the Loop Conductor of a PI agent Fusion loop. You do not execute. You read the run evidence and the four PI-agent views, then return ONLY a JSON object. The next PI-agent prompt depends on your output being machine-parseable JSON. No prose, no code fences, no commentary. Separate fact from inference in consensus and risk_flags.';

// ---- Config / roster resolution ----------------------------------------

export function resolveAssignments(roster, policy) {
  const assignments = [];
  for (const role of ALL_ROLES) {
    const entry = policy?.[role];
    const preferredId = entry?.preferred;
    const fallback = Array.isArray(entry?.fallback_order) ? entry.fallback_order : [];
    const order = [preferredId, ...fallback].filter(Boolean);
    let modelId = null;
    let usedFallback = false;
    for (const candidate of order) {
      if (roster && roster[candidate]) {
        modelId = candidate;
        if (candidate !== preferredId) usedFallback = true;
        break;
      }
    }
    assignments.push({
      pi_agent: role,
      model_id: modelId,
      provider_kind: modelId && roster?.[modelId]?.kind ? roster[modelId].kind : 'unresolved',
      selection_reason: entry?.reason || `Default assignment for ${role}.`,
      ...(usedFallback ? { fallback: true } : {}),
    });
  }
  return assignments;
}

// ---- View execution ----------------------------------------------------

export function buildViewPrompt(role, objective, runState) {
  return [
    `Run objective: ${objective}`,
    '',
    'Current loop step: ' + (runState?.loopStep ?? 1) + '.',
    '',
    'Run-state snapshot (evidence — treat as ground truth; cite where relevant):',
    formatRunState(runState),
    '',
    `Produce only your ${role} view. Be specific and brief. Cite concrete file names, commands, or timings from the snapshot where you can. Do not role-play the other views.`,
  ].join('\n');
}

// ---- Conductor ---------------------------------------------------------

export function buildConductorPrompt(objective, runState, views, assignments) {
  const schema = JSON.stringify(
    {
      schema_version: '1.0',
      status: 'continue | split | pause_for_human | possibly_stuck | complete',
      consensus: ['short points the views agree on'],
      tensions: [{ topic: 'short', stances: [{ pi_agent: 'Explorer|Builder|Critic|Performance Sentinel', stance: '...' }] }],
      risk_flags: ['specific risks derived from the evidence; empty array if none'],
      next_pi_agent: 'Explorer | Builder | Critic | Performance Sentinel',
      next_model_id: 'the roster model id best suited to execute next_prompt',
      next_prompt: 'a single concrete, directly-runnable PI-agent prompt: objective, constraints, allowed scope, required evidence, stop condition. No filler.',
      evidence_required: ['specific artifacts the next agent must produce'],
      stop_condition: 'a concrete, testable condition that ends the loop',
      handoff_reason: 'one sentence: why this next move',
    },
    null,
    2,
  );
  return [
    `Run objective: ${objective}`,
    '',
    'Current loop step: ' + (runState?.loopStep ?? 1) + '.',
    '',
    'Model assignments (these are the roster model ids available; next_model_id MUST be one of them or null):',
    JSON.stringify(assignments.map((a) => ({ pi_agent: a.pi_agent, model_id: a.model_id })), null, 2),
    '',
    'Run-state snapshot (evidence):',
    formatRunState(runState),
    '',
    'PI-agent views:',
    ...views.map((v) => `### ${v.role}\n${v.content}`),
    '',
    'Decision rules:',
    '- Prefer the smallest next step that creates new evidence.',
    '- If the Critic flags an untested behaviour risk, next_prompt must include a test or an explicit reason not to test.',
    '- If Performance Sentinel marks possibly_stuck, next_prompt must narrow scope.',
    '- If Explorer says the surface is unknown, do not jump to Builder; route back to Explorer.',
    '- Preserve Builder/Critic disagreement in tensions and choose a next prompt that resolves it with evidence.',
    '- If consensus exists but no stop condition is clear, create one before continuing.',
    '',
    'Return ONLY the JSON object. Schema (exact keys):',
    schema,
  ].join('\n');
}

export function parseDecision(rawOutput, assignments, runId) {
  const payload = extractJsonPayload(rawOutput);
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, error: 'Loop Conductor output was not valid JSON.', rawOutput };
  }

  const validModelIds = new Set(assignments.map((a) => a.model_id).filter(Boolean));
  const coerce = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const asArray = (value) => (Array.isArray(value) ? value : []);

  const decision = {
    schema_version: '1.0',
    run_id: runId,
    status: VALID_STATUSES.includes(parsed.status) ? parsed.status : 'continue',
    consensus: asArray(parsed.consensus),
    tensions: asArray(parsed.tensions),
    risk_flags: asArray(parsed.risk_flags),
    model_assignments: assignments.map((a) => ({ pi_agent: a.pi_agent, model_id: a.model_id })),
    next_pi_agent: VIEW_ROLES.includes(parsed.next_pi_agent) ? parsed.next_pi_agent : 'Builder',
    next_model_id: validModelIds.has(parsed.next_model_id) ? parsed.next_model_id : null,
    next_prompt: coerce(parsed.next_prompt, ''),
    evidence_required: asArray(parsed.evidence_required),
    stop_condition: coerce(parsed.stop_condition, ''),
    handoff_reason: coerce(parsed.handoff_reason, ''),
  };

  const notes = [];
  if (!VALID_STATUSES.includes(parsed.status)) {
    notes.push(`Conductor returned invalid status "${parsed.status}"; defaulted to continue.`);
  }
  if (!VIEW_ROLES.includes(parsed.next_pi_agent)) {
    notes.push(`Conductor returned unknown next_pi_agent "${parsed.next_pi_agent}"; defaulted to Builder.`);
  }
  if (parsed.next_model_id && !validModelIds.has(parsed.next_model_id)) {
    decision.risk_flags = [
      ...decision.risk_flags,
      `Conductor proposed next_model_id "${parsed.next_model_id}" which is not in the resolved roster; set to null.`,
    ];
  }
  if (!decision.next_prompt) {
    return { ok: false, error: 'Conductor returned no usable next_prompt.', rawOutput };
  }
  return { ok: true, decision, notes };
}

// ---- Orchestration -----------------------------------------------------

export async function runLoopedFusion(config, objective, runState, call, options = {}) {
  const runId = options.runId || makeRunId();
  const runDir = options.runDir || null;

  const assignments = resolveAssignments(config.model_roster, config.role_model_policy);
  const modelConfigFor = (role) => {
    const a = assignments.find((x) => x.pi_agent === role);
    if (!a || !a.model_id) {
      throw new Error(`No model assigned for role ${role} (roster/policy incomplete).`);
    }
    return modelConfigFromRoster(config.model_roster, a.model_id);
  };

  const views = [];
  const viewErrors = [];
  await Promise.all(
    VIEW_ROLES.map(async (role) => {
      try {
        const content = await call(
          modelConfigFor(role),
          [
            { role: 'system', content: VIEW_SYSTEMS[role] },
            { role: 'user', content: buildViewPrompt(role, objective, runState) },
          ],
        );
        views.push({ role, content: String(content || '').trim() });
      } catch (error) {
        viewErrors.push({ role, error: error?.message || String(error) });
      }
    }),
  );

  // Per PRD Error Handling: proceed only if >= 2 views succeeded.
  if (views.length < 2) {
    return {
      status: 'error',
      run_id: runId,
      decision: null,
      prompt: '',
      summary: `Aborted: only ${views.length}/4 views succeeded (${viewErrors.map((e) => e.role).join(', ') || 'none'}).`,
      views,
      view_errors: viewErrors,
      assignments,
    };
  }

  let conductorResult;
  try {
    const conductorRaw = await call(
      modelConfigFor('Loop Conductor'),
      [
        { role: 'system', content: CONDUCTOR_SYSTEM },
        { role: 'user', content: buildConductorPrompt(objective, runState, views, assignments) },
      ],
    );
    conductorResult = parseDecision(conductorRaw, assignments, runId);
  } catch (error) {
    return {
      status: 'error',
      run_id: runId,
      decision: null,
      prompt: '',
      summary: `Conductor call failed: ${error?.message || String(error)}.`,
      views,
      view_errors: viewErrors,
      assignments,
    };
  }

  if (!conductorResult.ok) {
    return {
      status: 'error',
      run_id: runId,
      decision: null,
      prompt: '',
      summary: conductorResult.error,
      views,
      view_errors: viewErrors,
      assignments,
      raw_conductor_output: conductorResult.rawOutput || undefined,
    };
  }

  const { decision } = conductorResult;
  const prompt = renderPromptFile(decision, objective);
  const summary = renderSummary(decision, views, viewErrors, conductorResult.notes || []);

  if (runDir) {
    await writeArtifacts(runDir, runId, objective, runState, assignments, views, viewErrors, decision, prompt, summary);
  }

  return {
    status: 'ok',
    run_id: runId,
    decision,
    prompt,
    summary,
    views,
    view_errors: viewErrors,
    assignments,
    conductor_notes: conductorResult.notes || [],
  };
}

// ---- Artifact writers --------------------------------------------------

export async function writeArtifacts(runDir, runId, objective, runState, assignments, views, viewErrors, decision, prompt, summary) {
  const dir = join(runDir, 'artifacts', 'pi-fusion');
  await mkdir(dir, { recursive: true });

  const write = async (name, body) => writeFile(join(dir, name), body);
  await write('model-assignments.json', JSON.stringify({ schema_version: '1.0', assignments }, null, 2));
  for (const view of views) {
    await write(`${kebab(view.role)}-view.md`, view.content);
  }
  await write('loop-conductor-decision.json', JSON.stringify(decision, null, 2));
  await write('loop-conductor-prompt.md', prompt);
  await write('loop-conductor-summary.md', summary);
}

export function renderPromptFile(decision, objective) {
  return [
    `# Loop Conductor prompt — ${decision.run_id}`,
    '',
    `- Target PI agent: **${decision.next_pi_agent}**`,
    decision.next_model_id ? `- Target model: \`${decision.next_model_id}\`` : '- Target model: _unset_',
    `- Objective: ${objective}`,
    '',
    '## Next prompt',
    '',
    decision.next_prompt || '_(empty)_',
    '',
    '## Required evidence',
    ...(decision.evidence_required.length ? decision.evidence_required.map((e) => `- ${e}`) : ['- _(none specified)_']),
    '',
    '## Stop condition',
    '',
    decision.stop_condition || '_(unspecified)_',
  ].join('\n');
}

export function renderSummary(decision, views, viewErrors, notes) {
  return [
    `# Loop Conductor summary — ${decision.run_id}`,
    '',
    `**Status:** ${decision.status}  |  **Next:** ${decision.next_pi_agent}${decision.next_model_id ? ` (${decision.next_model_id})` : ''}`,
    '',
    `**Handoff reason:** ${decision.handoff_reason || '_(none)_'}`
, '',
    '## Consensus',
    ...(decision.consensus.length ? decision.consensus.map((c) => `- ${c}`) : ['- _(none)_']),
    '',
    '## Tensions',
    ...(decision.tensions.length
      ? decision.tensions.map((t) => `- **${t.topic || 'unnamed'}** — ${(t.stances || [])
          .map((s) => `${s.pi_agent}: ${s.stance}`)
          .join(' / ')}`)
      : ['- _(none)_']),
    '',
    '## Risk flags',
    ...(decision.risk_flags.length ? decision.risk_flags.map((r) => `- ${r}`) : ['- _(none)_']),
    '',
    `## Views present: ${views.map((v) => v.role).join(', ') || 'none'}${viewErrors.length ? `  |  failed: ${viewErrors.map((e) => e.role).join(', ')}` : ''}`,
    ...(notes.length ? ['', '## Parser notes', ...notes.map((n) => `- ${n}`)] : []),
  ].join('\n');
}

// ---- Run-state formatting ----------------------------------------------

export function formatRunState(runState) {
  if (!runState || Object.keys(runState).length === 0) return '_(no run-state provided)_';
  const lines = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && value !== '') lines.push(`- ${label}: ${value}`);
  };
  push('Loop step', runState.loopStep);
  push('Heartbeat', runState.heartbeat);
  push('Elapsed', runState.elapsed);
  push('Expected', runState.expected);
  push('Health verdict', runState.health);
  if (Array.isArray(runState.recentCommands) && runState.recentCommands.length) {
    lines.push('- Recent commands:');
    for (const cmd of runState.recentCommands.slice(-8)) lines.push(`    - ${cmd}`);
  }
  if (Array.isArray(runState.recentMessages) && runState.recentMessages.length) {
    lines.push('- Recent agent activity:');
    for (const msg of runState.recentMessages.slice(-8)) lines.push(`    - ${msg}`);
  }
  if (runState.notes) lines.push(`- Notes: ${runState.notes}`);
  return lines.length ? lines.join('\n') : '_(empty run-state)_';
}

// ---- Helpers -----------------------------------------------------------

function modelConfigFromRoster(roster, modelId) {
  const entry = roster?.[modelId];
  if (!entry) throw new Error(`Model "${modelId}" not found in roster.`);
  // The roster may declare a provider/modelId directly, or reuse a pi-backend
  // provider+modelId. We normalize to the shape `chatViaPi` expects.
  return {
    backend: 'pi',
    name: modelId,
    provider: entry.provider,
    modelId: entry.modelId || entry.model || modelId,
    system: '',
  };
}

function makeRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-looped-pi-fusion`;
}

function kebab(value) {
  return String(value).toLowerCase().replace(/\s+/g, '-');
}
