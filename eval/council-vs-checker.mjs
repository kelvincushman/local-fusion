#!/usr/bin/env node
// Council vs. single-reviewer eval.
//
// For each fixture x trials, several arms review the SAME frozen evidence:
//   checker        - the production gate: one model + the terse checker prompt (checkWork)
//   single         - the SAME model, but an exhaustive "find every issue" review prompt
//   council        - diverse panel + judge + synthesizer (fuseReview -> runFusion)
//   council_homog  - (--diversity) same panel/judge/synth but every panel member forced
//                    to ONE model, isolating "model diversity" from "more perspectives"
//
// Grading is either a coarse keyword match (default) or an LLM judge (--grader llm).
// Confidence calibration of the checker is computed from the same runs.
//
// Usage:
//   node eval/council-vs-checker.mjs [--trials N] [--config path] [--fixtures id,id]
//                                    [--parallel] [--grader keyword|llm] [--diversity] [--offline]

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import {
  startLoop,
  appendReport,
  checkWork,
  fuseReview,
  buildFusionReviewPrompt,
  normalizeReport,
} from '../src/mcp-connector.mjs';
import { extractJsonPayload } from '../src/fusion.mjs';
import { createPiClient, chatViaPi } from '../src/pi-transport.mjs';
import { FIXTURES, NOISE_SIGNALS } from './fixtures.mjs';

// The council arm fires several panel calls at once. If one times out we catch it,
// but the others can reject later with no awaiter. Swallow those orphaned rejections
// so a single slow call can't kill the run; the per-trial try/catch records the real one.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`  [unhandledRejection ignored] ${reason?.message || reason}\n`);
});

// Pi calls on big-context council prompts can exceed the default 120s.
const EVAL_TIMEOUT_MS = 300000;

const SINGLE_REVIEW_SYSTEM = [
  'You are a meticulous senior staff engineer doing a pre-merge review.',
  'You see only the frozen evidence: objective, acceptance criteria, the executor report,',
  "and a prior checker's findings. List EVERY real bug, robustness gap, security issue,",
  'scope/over-engineering (YAGNI) problem, and missing test you can justify from the evidence.',
  'Be exhaustive and specific, and cite the evidence for each point. Do not invent files or',
  'commands. If the work is genuinely fine, say so plainly.',
].join(' ');

const GRADER_SYSTEM = 'You are a strict, conservative grader. Output only JSON.';

function parseArgs(argv) {
  const opts = { trials: 3, config: 'local-fusion.config.json', offline: false, fixtures: null, parallel: false, grader: 'keyword', diversity: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--parallel') opts.parallel = true;
    else if (a === '--diversity') opts.diversity = true;
    else if (a === '--trials') opts.trials = Number(argv[++i]);
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--grader') opts.grader = argv[++i];
    else if (a === '--fixtures') opts.fixtures = String(argv[++i]).split(',').map((s) => s.trim());
  }
  return opts;
}

function resolveSingleModel(config) {
  return config.checker || config.mcp_checker || config.synthesizer || config.judge;
}

// --- text extraction (original case; graders lowercase as needed) ---
function checkerText(check) {
  return [
    ...(check.missing_requirements || []),
    ...(check.likely_bugs || []),
    ...(check.verification_gaps || []),
    ...(check.exact_next_actions || []),
    check.handoff_reason || '',
  ].join(' \n ');
}

function councilText(fusion) {
  const a = fusion.analysis || {};
  const parts = [fusion.final_answer || ''];
  for (const key of ['consensus', 'blind_spots', 'judge_notes']) parts.push(...(a[key] || []));
  for (const pc of a.partial_coverage || []) parts.push(pc.point || '');
  for (const ui of a.unique_insights || []) parts.push(ui.insight || '');
  for (const c of a.contradictions || []) for (const s of c.stances || []) parts.push(s.stance || '');
  return parts.join(' \n ');
}

// --- grading ---
function detectKeyword(planted, text) {
  const t = text.toLowerCase();
  return planted.map((issue) => ({ id: issue.id, detected: issue.match.some((m) => t.includes(m.toLowerCase())) }));
}

function buildGraderPrompt(planted, text) {
  const list = planted.map((p) => `- ${p.id}: ${p.description}`).join('\n');
  return [
    'A REVIEW of some code is given below, plus a list of KNOWN ISSUES that may or may not be present in the review.',
    'For each known issue id, decide whether the review clearly identifies that specific issue (wording may differ).',
    'Be conservative: only true if the review genuinely raises it. Return ONLY a JSON object mapping id -> true/false.',
    '',
    'KNOWN ISSUES:',
    list,
    '',
    'REVIEW:',
    String(text).slice(0, 12000),
  ].join('\n');
}

async function detectLLM(call, graderModel, planted, text) {
  if (!planted.length) return [];
  const raw = await call(graderModel, [
    { role: 'system', content: GRADER_SYSTEM },
    { role: 'user', content: buildGraderPrompt(planted, text) },
  ]);
  let obj = {};
  try { obj = JSON.parse(extractJsonPayload(raw)); } catch { obj = {}; }
  return planted.map((p) => ({ id: p.id, detected: obj[p.id] === true || String(obj[p.id]).toLowerCase() === 'true' }));
}

function noiseScore(text) {
  const t = text.toLowerCase();
  return NOISE_SIGNALS.filter((s) => t.includes(s)).length;
}

function pct(n, d) {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = await loadConfig(opts.config);
  config.timeoutMs = Math.max(Number(config.timeoutMs) || 0, EVAL_TIMEOUT_MS);
  if (opts.parallel) config.parallel = true; // fire panel members concurrently (#1)
  const singleModel = resolveSingleModel(config);
  const graderModel = config.judge || config.synthesizer; // grade with a model distinct from the single/checker
  const rootDir = join('run-output', 'eval-state');
  const fixtures = opts.fixtures ? FIXTURES.filter((f) => opts.fixtures.includes(f.id)) : FIXTURES;

  const ARMS = ['checker', 'single', 'council', ...(opts.diversity ? ['council_homog'] : [])];

  // #3: homogeneous council — every panel member forced onto the single model, but
  // each keeps its role system-prompt and name. Holds count + role prompts + judge +
  // synthesizer constant, so council-vs-council_homog isolates *model diversity*.
  const homogConfig = opts.diversity
    ? { ...config, panel: config.panel.map((p) => ({ ...p, backend: singleModel.backend, provider: singleModel.provider, modelId: singleModel.modelId, model: singleModel.model })) }
    : null;

  // The injectable call seam. Offline uses a deterministic stub (numbers NOT real).
  // With --parallel we keep a POOL of Pi clients keyed by provider:model so independent
  // panel members hit separate subprocesses and actually overlap (#1).
  const piPool = new Map();
  const poolKey = (m) => (opts.parallel ? `${m.provider || ''}:${m.modelId || m.model || ''}` : 'shared');
  const getClient = (m) => {
    const k = poolKey(m);
    if (!piPool.has(k)) piPool.set(k, createPiClient({ timeoutMs: config.timeoutMs }));
    return piPool.get(k);
  };
  const closePool = async () => {
    for (const c of piPool.values()) { try { await c.close(); } catch { /* ignore */ } }
    piPool.clear();
  };

  let call;
  if (opts.offline) {
    call = async (modelConfig, messages) => {
      const user = messages[messages.length - 1]?.content || '';
      if (user.includes('Return ONLY JSON')) {
        return JSON.stringify({ status: 'done', confidence: 0.9, missing_requirements: [], likely_bugs: [], verification_gaps: [], exact_next_actions: [], evidence_used: ['stub'], recommended_route: 'stop', handoff_reason: 'offline stub' });
      }
      if (user.includes('KNOWN ISSUES:')) return '{}';
      return 'OFFLINE STUB REVIEW: no real analysis performed.';
    };
  } else {
    call = async (modelConfig, messages) => {
      if (modelConfig.backend === 'pi') return chatViaPi(getClient(modelConfig), modelConfig, messages, { timeoutMs: config.timeoutMs });
      const { chatCompletion } = await import('../src/openai-compatible.mjs');
      return chatCompletion(modelConfig, messages, { timeoutMs: config.timeoutMs });
    };
  }

  const runs = [];
  const failures = [];
  try {
    for (const fx of fixtures) {
      for (let t = 0; t < opts.trials; t += 1) {
        const runId = `${fx.id}-t${t}`;
        try {
          await startLoop(rootDir, { run_id: runId, objective: fx.objective, acceptance_criteria: fx.acceptance_criteria });
          await appendReport(rootDir, { run_id: runId, ...fx.report });

          const checker = await checkWork(config, rootDir, { run_id: runId }, { call });
          const review = await fuseReview(config, rootDir, { run_id: runId, check: checker.check }, { call });

          const state = { objective: fx.objective, acceptance_criteria: fx.acceptance_criteria };
          const body = buildFusionReviewPrompt(state, normalizeReport({ ...fx.report, run_id: runId }), checker.check);
          const single = await call(singleModel, [
            { role: 'system', content: SINGLE_REVIEW_SYSTEM },
            { role: 'user', content: body },
          ]);

          const homog = homogConfig ? await fuseReview(homogConfig, rootDir, { run_id: runId, check: checker.check }, { call }) : null;

          const texts = {
            checker: checkerText(checker.check),
            single: String(single),
            council: councilText(review.review.fusion),
            ...(homog ? { council_homog: councilText(homog.review.fusion) } : {}),
          };

          const keyword = {};
          for (const arm of ARMS) keyword[arm] = detectKeyword(fx.planted_issues, texts[arm]);
          let llm = null;
          if (opts.grader === 'llm') {
            llm = {};
            for (const arm of ARMS) llm[arm] = await detectLLM(call, graderModel, fx.planted_issues, texts[arm]);
          }

          const noise = {};
          for (const arm of ARMS) noise[arm] = noiseScore(texts[arm]);

          runs.push({
            fixture: fx.id,
            trial: t,
            isControl: fx.planted_issues.length === 0,
            confidence: typeof checker.check.confidence === 'number' ? checker.check.confidence : null,
            detections: { keyword, llm },
            noise,
            raw: { checker: checker.check, single, council: review.review.fusion, council_homog: homog ? homog.review.fusion : null },
          });
          process.stderr.write(`  ran ${runId}\n`);
        } catch (err) {
          failures.push({ fixture: fx.id, trial: t, error: String(err?.message || err) });
          process.stderr.write(`  FAILED ${runId}: ${err?.message || err}\n`);
          if (!opts.offline) await closePool(); // drop wedged subprocesses; respawn lazily
        }
      }
    }
  } finally {
    await closePool();
  }

  const report = aggregate(runs, fixtures, opts, ARMS);
  report.failures = failures;
  await mkdir('run-output', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = join('run-output', `eval-${stamp}.json`);
  const rawJson = JSON.stringify({ opts, model: singleModel?.name || singleModel?.modelId, grader: graderModel?.name, failures, runs }, null, 2);
  await writeFile(rawPath, rawJson);
  await mkdir('eval', { recursive: true });
  const committedRaw = 'eval/raw-results.json';
  await writeFile(committedRaw, rawJson);
  await writeFile('eval/RESULTS.md', renderResults(report, opts, committedRaw, singleModel));
  process.stdout.write('\n' + report.table + '\n');
  if (report.calibrationText) process.stdout.write('\n' + report.calibrationText + '\n');
  process.stdout.write(`\nRaw per-run dump: ${rawPath}\nSummary: eval/RESULTS.md\n`);
}

const ARM_LABELS = { checker: 'Checker', single: 'Single reviewer', council: 'Council (diverse)', council_homog: 'Council (same-model)' };

function activeDetections(run, opts) {
  return opts.grader === 'llm' && run.detections.llm ? run.detections.llm : run.detections.keyword;
}

function aggregate(runs, fixtures, opts, ARMS) {
  const rows = [];
  const totals = Object.fromEntries(ARMS.map((a) => [a, { d: 0, n: 0 }]));
  let control = null;

  for (const fx of fixtures) {
    const fxRuns = runs.filter((r) => r.fixture === fx.id);
    if (!fxRuns.length) continue;
    if (fx.planted_issues.length === 0) {
      control = { id: fx.id, noise: Object.fromEntries(ARMS.map((a) => [a, (fxRuns.reduce((s, r) => s + (r.noise[a] || 0), 0) / fxRuns.length).toFixed(1)])) };
      continue;
    }
    const denom = fx.planted_issues.length * fxRuns.length;
    const cell = {};
    for (const arm of ARMS) {
      const d = fxRuns.reduce((s, r) => s + activeDetections(r, opts)[arm].filter((x) => x.detected).length, 0);
      cell[arm] = { d, denom };
      totals[arm].d += d;
      totals[arm].n += denom;
    }
    rows.push({ id: fx.id, issues: fx.planted_issues.length, cell });
  }

  const lines = [];
  lines.push(`| Fixture | Issues | ${ARMS.map((a) => ARM_LABELS[a]).join(' | ')} |`);
  lines.push(`|---|---|${ARMS.map(() => '---').join('|')}|`);
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.issues} | ${ARMS.map((a) => `${r.cell[a].d}/${r.cell[a].denom} (${pct(r.cell[a].d, r.cell[a].denom)})`).join(' | ')} |`);
  }
  lines.push(`| **Overall** | | ${ARMS.map((a) => `**${pct(totals[a].d, totals[a].n)}**`).join(' | ')} |`);

  return { table: lines.join('\n'), totals, control, rows, calibrationText: calibration(runs, opts) };
}

// #4: does the checker's reported confidence predict whether it actually found the bugs?
function calibration(runs, opts) {
  const pts = runs
    .filter((r) => !r.isControl && typeof r.confidence === 'number')
    .map((r) => {
      const det = activeDetections(r, opts).checker;
      const found = det.filter((x) => x.detected).length;
      return { conf: r.confidence, frac: det.length ? found / det.length : 0 };
    });
  if (!pts.length) return '';
  const buckets = [
    { label: 'conf <0.55', lo: 0, hi: 0.55 },
    { label: '0.55–0.8', lo: 0.55, hi: 0.8 },
    { label: '0.8–1.0', lo: 0.8, hi: 1.01 },
  ];
  const rows = buckets.map((b) => {
    const inB = pts.filter((p) => p.conf >= b.lo && p.conf < b.hi);
    const avg = inB.length ? inB.reduce((s, p) => s + p.frac, 0) / inB.length : null;
    return { label: b.label, n: inB.length, avg };
  });
  const meanConf = pts.reduce((s, p) => s + p.conf, 0) / pts.length;
  const meanFrac = pts.reduce((s, p) => s + p.frac, 0) / pts.length;
  const out = ['## Checker confidence calibration (#4)', ''];
  out.push('| Checker confidence | Runs | Avg planted-issue detection |');
  out.push('|---|---|---|');
  for (const r of rows) out.push(`| ${r.label} | ${r.n} | ${r.avg === null ? '—' : `${Math.round(r.avg * 100)}%`} |`);
  out.push('');
  out.push(`Mean checker confidence **${meanConf.toFixed(2)}** vs mean actual detection **${Math.round(meanFrac * 100)}%** — a gap this large means the checker is **overconfident**, which is the case for routing low-confidence work to the council automatically.`);
  return out.join('\n');
}

function renderResults(report, opts, rawPath, singleModel) {
  const ctrl = report.control;
  const graderNote = opts.grader === 'llm'
    ? 'an **LLM judge** decides whether each planted issue is identified (conservative, JSON verdict).'
    : 'a planted issue counts as *detected* if any of its `match` synonyms appears in the output (coarse keyword proxy).';
  return [
    '# Council vs. single-reviewer eval — results',
    '',
    opts.offline ? '> **OFFLINE STUB RUN — these numbers are not meaningful.** Re-run without `--offline`.' : '',
    '',
    `Detection rate of planted issues across **${opts.trials} trial(s)** per fixture. Higher is better.`,
    `Grader: **${opts.grader}**. "Checker" and "single reviewer" use the same model (\`${singleModel?.name || singleModel?.modelId || 'configured checker'}\`); only the prompt differs.`,
    opts.diversity ? '"Council (same-model)" forces every panel member onto that one model, isolating model diversity from extra perspectives (#3).' : '',
    '',
    report.table,
    '',
    ctrl ? `**Clean-control over-flagging** (\`${ctrl.id}\`, no planted issues — lower is better, avg "serious problem" signal hits): ${Object.entries(ctrl.noise).map(([a, v]) => `${ARM_LABELS[a]} ${v}`).join(', ')}.` : '',
    '',
    (report.failures && report.failures.length) ? `**Failed trials (excluded):** ${report.failures.length} — ${report.failures.map((f) => `${f.fixture}-t${f.trial}`).join(', ')}.` : '',
    '',
    report.calibrationText || '',
    '',
    '## Methodology',
    '',
    '- **Arms (identical evidence):** checker (terse gate) · single reviewer (same model, exhaustive prompt) · council (diverse panel + judge + synthesizer)' + (opts.diversity ? ' · council same-model (panel forced to one model).' : '.'),
    `- **Grading:** ${graderNote} Raw outputs are committed so anyone can re-grade.`,
    '- **Dataset:** `eval/fixtures.mjs` — realistic build reports that meet their acceptance criteria but hide known',
    "  issues. Themes overlap with Scott Logic's \"Ponytail? YAGNI!\" post (rate-limit, csv-sum, debounce, JWT, etc.).",
    '- **Limitations:** small N with non-deterministic models (wide error bars); planted issues are not real PRs;',
    '  results are specific to this model + harness (effectiveness = skill + model + harness).',
    '',
    `Raw per-run outputs (committed): \`${rawPath}\`. Re-run: \`node eval/council-vs-checker.mjs --trials ${opts.trials}${opts.parallel ? ' --parallel' : ''}${opts.grader === 'llm' ? ' --grader llm' : ''}${opts.diversity ? ' --diversity' : ''}\`.`,
    '',
  ].filter((l) => l !== '').join('\n') + '\n';
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
