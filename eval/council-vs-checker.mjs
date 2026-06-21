#!/usr/bin/env node
// Council vs. single-reviewer eval.
//
// For each fixture x trials, three arms review the SAME frozen evidence:
//   A. checker      - the production gate: one model + the terse checker prompt (checkWork)
//   B. strong-single- the SAME model, but an exhaustive "find every issue" review prompt
//   C. council      - multiple models + judge + synthesizer (fuseReview -> runFusion)
//
// Arms B and C see an identical prompt body (buildFusionReviewPrompt), so the only
// variables are prompt-style (A vs B) and single-vs-multi (B vs C). Grading is a
// deliberately coarse keyword match against planted issues (disclosed in RESULTS.md).
//
// Usage:
//   node eval/council-vs-checker.mjs [--trials N] [--config path] [--fixtures id,id] [--offline]

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
import { createPiClient, chatViaPi } from '../src/pi-transport.mjs';
import { FIXTURES, NOISE_SIGNALS } from './fixtures.mjs';

// The council arm fires several panel calls at once. If one times out we catch it,
// but the others can reject later with no awaiter (e.g. after we recycle a wedged
// Pi client). Swallow those orphaned rejections so a single slow call can't kill
// the whole benchmark; the per-trial try/catch still records the real failure.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`  [unhandledRejection ignored] ${reason?.message || reason}\n`);
});

// Pi calls on big-context council/JWT prompts can exceed the default 120s. Give
// every arm a generous ceiling so timeouts are rare, not the common case.
const EVAL_TIMEOUT_MS = 300000;

const SINGLE_REVIEW_SYSTEM = [
  'You are a meticulous senior staff engineer doing a pre-merge review.',
  'You see only the frozen evidence: objective, acceptance criteria, the executor report,',
  "and a prior checker's findings. List EVERY real bug, robustness gap, security issue,",
  'scope/over-engineering (YAGNI) problem, and missing test you can justify from the evidence.',
  'Be exhaustive and specific, and cite the evidence for each point. Do not invent files or',
  'commands. If the work is genuinely fine, say so plainly.',
].join(' ');

function parseArgs(argv) {
  const opts = { trials: 3, config: 'local-fusion.config.json', offline: false, fixtures: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--trials') opts.trials = Number(argv[++i]);
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--fixtures') opts.fixtures = String(argv[++i]).split(',').map((s) => s.trim());
  }
  return opts;
}

function resolveSingleModel(config) {
  return config.checker || config.mcp_checker || config.synthesizer || config.judge;
}

// Flatten an arm's output into one lowercased string for keyword grading.
function checkerText(check) {
  return [
    ...(check.missing_requirements || []),
    ...(check.likely_bugs || []),
    ...(check.verification_gaps || []),
    ...(check.exact_next_actions || []),
    check.handoff_reason || '',
  ].join(' \n ').toLowerCase();
}

function councilText(fusion) {
  const a = fusion.analysis || {};
  const parts = [fusion.final_answer || ''];
  for (const key of ['consensus', 'blind_spots', 'judge_notes']) parts.push(...(a[key] || []));
  for (const pc of a.partial_coverage || []) parts.push(pc.point || '');
  for (const ui of a.unique_insights || []) parts.push(ui.insight || '');
  for (const c of a.contradictions || []) for (const s of c.stances || []) parts.push(s.stance || '');
  return parts.join(' \n ').toLowerCase();
}

function detect(planted, text) {
  return planted.map((issue) => ({
    id: issue.id,
    detected: issue.match.some((m) => text.includes(m.toLowerCase())),
  }));
}

function noiseScore(text) {
  return NOISE_SIGNALS.filter((s) => text.includes(s)).length;
}

function pct(n, d) {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = await loadConfig(opts.config);
  config.timeoutMs = Math.max(Number(config.timeoutMs) || 0, EVAL_TIMEOUT_MS);
  const singleModel = resolveSingleModel(config);
  const rootDir = join('run-output', 'eval-state');
  const fixtures = opts.fixtures ? FIXTURES.filter((f) => opts.fixtures.includes(f.id)) : FIXTURES;

  // The single injectable call seam. Offline uses a deterministic stub so the
  // harness can be smoke-tested without burning model calls (numbers are NOT real).
  let piClient = null;
  let call;
  if (opts.offline) {
    call = async (modelConfig, messages) => {
      const user = messages[messages.length - 1]?.content || '';
      if (user.includes('Return ONLY JSON')) {
        return JSON.stringify({ status: 'done', confidence: 0.9, missing_requirements: [], likely_bugs: [], verification_gaps: [], exact_next_actions: [], evidence_used: ['stub'], recommended_route: 'stop', handoff_reason: 'offline stub' });
      }
      return 'OFFLINE STUB REVIEW: no real analysis performed.';
    };
  } else {
    piClient = createPiClient({ timeoutMs: config.timeoutMs });
    call = async (modelConfig, messages) => {
      if (modelConfig.backend === 'pi') return chatViaPi(piClient, modelConfig, messages, { timeoutMs: config.timeoutMs });
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

          // Arm A: checker gate.
          const checker = await checkWork(config, rootDir, { run_id: runId }, { call });

          // Arm C: council (uses buildFusionReviewPrompt internally with the same check).
          const review = await fuseReview(config, rootDir, { run_id: runId, check: checker.check }, { call });

          // Arm B: strong single reviewer — same model, same evidence body, exhaustive prompt.
          const state = { objective: fx.objective, acceptance_criteria: fx.acceptance_criteria };
          const body = buildFusionReviewPrompt(state, normalizeReport({ ...fx.report, run_id: runId }), checker.check);
          const single = await call(singleModel, [
            { role: 'system', content: SINGLE_REVIEW_SYSTEM },
            { role: 'user', content: body },
          ]);

          const texts = {
            checker: checkerText(checker.check),
            single: String(single).toLowerCase(),
            council: councilText(review.review.fusion),
          };
          runs.push({
            fixture: fx.id,
            trial: t,
            isControl: fx.planted_issues.length === 0,
            detections: {
              checker: detect(fx.planted_issues, texts.checker),
              single: detect(fx.planted_issues, texts.single),
              council: detect(fx.planted_issues, texts.council),
            },
            noise: {
              checker: noiseScore(texts.checker),
              single: noiseScore(texts.single),
              council: noiseScore(texts.council),
            },
            raw: { checker: checker.check, single, council: review.review.fusion },
          });
          process.stderr.write(`  ran ${runId}\n`);
        } catch (err) {
          // One slow/timed-out model call must not abort the whole benchmark.
          failures.push({ fixture: fx.id, trial: t, error: String(err?.message || err) });
          process.stderr.write(`  FAILED ${runId}: ${err?.message || err}\n`);
          if (!opts.offline) {
            // A timed-out Pi RPC can leave the subprocess wedged; recreate it.
            try { await piClient.close(); } catch { /* ignore */ }
            piClient = createPiClient({ timeoutMs: config.timeoutMs });
          }
        }
      }
    }
  } finally {
    if (piClient) await piClient.close();
  }

  const report = aggregate(runs, fixtures, opts);
  report.failures = failures;
  await mkdir('run-output', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = join('run-output', `eval-${stamp}.json`);
  const rawJson = JSON.stringify({ opts, model: singleModel?.name || singleModel?.modelId, failures, runs }, null, 2);
  await writeFile(rawPath, rawJson);
  await mkdir('eval', { recursive: true });
  // Committed canonical copy so the published results stay auditable in-repo.
  const committedRaw = 'eval/raw-results.json';
  await writeFile(committedRaw, rawJson);
  await writeFile('eval/RESULTS.md', renderResults(report, opts, committedRaw, singleModel));
  process.stdout.write('\n' + report.table + '\n');
  process.stdout.write(`\nRaw per-run dump: ${rawPath}\nSummary: eval/RESULTS.md\n`);
}

function aggregate(runs, fixtures, opts) {
  const ARMS = ['checker', 'single', 'council'];
  const rows = [];
  const totals = { checker: { d: 0, n: 0 }, single: { d: 0, n: 0 }, council: { d: 0, n: 0 } };
  let control = null;

  for (const fx of fixtures) {
    const fxRuns = runs.filter((r) => r.fixture === fx.id);
    if (!fxRuns.length) continue;
    if (fx.planted_issues.length === 0) {
      const noise = {};
      for (const arm of ARMS) noise[arm] = (fxRuns.reduce((s, r) => s + r.noise[arm], 0) / fxRuns.length).toFixed(1);
      control = { id: fx.id, noise };
      continue;
    }
    const denom = fx.planted_issues.length * fxRuns.length;
    const cell = {};
    for (const arm of ARMS) {
      const d = fxRuns.reduce((s, r) => s + r.detections[arm].filter((x) => x.detected).length, 0);
      cell[arm] = { d, denom };
      totals[arm].d += d;
      totals[arm].n += denom;
    }
    rows.push({ id: fx.id, issues: fx.planted_issues.length, cell });
  }

  const lines = [];
  lines.push('| Fixture | Issues | Checker | Single reviewer | Council |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.issues} | ${r.cell.checker.d}/${r.cell.checker.denom} (${pct(r.cell.checker.d, r.cell.checker.denom)}) | ${r.cell.single.d}/${r.cell.single.denom} (${pct(r.cell.single.d, r.cell.single.denom)}) | ${r.cell.council.d}/${r.cell.council.denom} (${pct(r.cell.council.d, r.cell.council.denom)}) |`);
  }
  lines.push(`| **Overall** | | **${pct(totals.checker.d, totals.checker.n)}** | **${pct(totals.single.d, totals.single.n)}** | **${pct(totals.council.d, totals.council.n)}** |`);

  return { table: lines.join('\n'), totals, control, rows };
}

function renderResults(report, opts, rawPath, singleModel) {
  const overall = report.totals;
  const ctrl = report.control;
  return [
    '# Council vs. single-reviewer eval — results',
    '',
    opts.offline ? '> **OFFLINE STUB RUN — these numbers are not meaningful.** Re-run without `--offline`.' : '',
    '',
    `Detection rate of planted issues across **${opts.trials} trial(s)** per fixture. Higher is better.`,
    'All three arms reviewed identical frozen evidence. "Checker" and "single reviewer" use the same',
    `model (\`${singleModel?.name || singleModel?.modelId || 'configured checker'}\`); only the prompt differs.`,
    '',
    report.table,
    '',
    ctrl ? `**Clean-control over-flagging** (\`${ctrl.id}\`, no planted issues — lower is better, avg "serious problem" signal hits): checker ${ctrl.noise.checker}, single ${ctrl.noise.single}, council ${ctrl.noise.council}.` : '',
    '',
    (report.failures && report.failures.length) ? `**Failed trials (excluded from rates):** ${report.failures.length} — ${report.failures.map((f) => `${f.fixture}-t${f.trial}`).join(', ')}. Detection rates are computed only over successful trials.` : '',
    '',
    '## Methodology',
    '',
    '- **Arms (identical evidence):** (A) production checker gate — one model + terse JSON checker prompt;',
    '  (B) strong single reviewer — the same model + an exhaustive review prompt; (C) council — panel + judge + synthesizer.',
    '- **Dataset:** `eval/fixtures.mjs` — realistic build reports that meet their acceptance criteria but hide',
    "  known issues. Task themes overlap with Scott Logic's \"Ponytail? YAGNI!\" post (rate-limit, csv-sum, debounce, JWT).",
    '- **Grading:** a planted issue counts as *detected* if any of its `match` synonyms appears in the arm\'s output.',
    '  This is a deliberately coarse, deterministic proxy (no LLM grader). Raw outputs are published so anyone can audit.',
    '- **Limitations:** keyword grading misses paraphrases and can over-credit; models are non-deterministic (hence trials);',
    '  planted issues are not real PRs; results are specific to this model + harness (effectiveness = skill + model + harness).',
    '',
    `Raw per-run outputs: \`${rawPath}\`. Re-run: \`node eval/council-vs-checker.mjs --trials ${opts.trials}\`.`,
    '',
  ].filter((l) => l !== '').join('\n') + '\n';
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
