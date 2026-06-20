// Pi extension: /looped slash command.
//
// Runs ONE Loop Conductor round of Looped PI Fusion (docs/prd-pi-agent-fusion-loop.md)
// against the current repo, then injects the conductor's next_prompt into the
// session as a steering/context message so your brain model reasons over it.
//
// V1 is a Prompt Driver (per the PRD): this command never edits files or runs
// tests. It gathers views, gets a decision, and writes artifacts + a next prompt.
//
// Usage inside Pi:   /looped <objective>
//
// Models are routed through Pi's own subscriptions via the local-fusion `pi`
// backend (no API keys here). The roster lives in looped-fusion.config.json.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'looped-fusion.config.json');
const RUNS_ROOT = join(REPO_ROOT, 'runs');

export default function (pi: ExtensionAPI) {
  pi.registerCommand('looped', {
    description: 'Run one Loop Conductor round of Looped PI Fusion and show the next prompt.',
    handler: async (args, ctx) => {
      const objective = (args || '').trim();
      if (!objective) {
        ctx.ui.notify('Usage: /looped <objective>', 'warning');
        return;
      }

      const runState = snapshotRunState(ctx);
      const runId = makeRunId();
      const runDir = join(RUNS_ROOT, runId);

      ctx.ui.setStatus('looped-fusion', 'Running Loop Conductor round…');
      try {
        const result = await runViaCli(objective, runState, runId, runDir);
        presentResult(ctx, result, objective);
      } catch (error: any) {
        ctx.ui.notify(`Loop Conductor failed: ${error?.message || String(error)}`, 'error');
      } finally {
        ctx.ui.setStatus('looped-fusion', undefined as any);
      }
    },
  });
}

function snapshotRunState(ctx: any) {
  const sm = ctx?.sessionManager;
  let recentMessages: string[] = [];
  let loopStep = 1;
  if (sm && typeof sm.getEntries === 'function') {
    try {
      const entries = sm.getEntries() || [];
      recentMessages = entries
        .slice(-8)
        .map((e: any) => summarizeEntry(e))
        .filter(Boolean);
      loopStep = Math.max(1, Math.floor(entries.length / 4));
    } catch {
      // best-effort: leave defaults
    }
  }
  return {
    loopStep,
    heartbeat: 'fresh',
    health: 'healthy',
    elapsed: undefined,
    expected: undefined,
    recentMessages,
    notes: `cwd=${ctx?.cwd ?? process.cwd()}; ${recentMessages.length} recent entries`,
  };
}

function summarizeEntry(entry: any): string {
  if (!entry) return '';
  const role = entry.role || entry.type || '?';
  const content = entry.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((c: any) => (typeof c === 'string' ? c : c?.text || c?.command || ''))
      .filter(Boolean)
      .join(' ');
  }
  text = (text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `${role}: ${text.slice(0, 180)}`;
}

// Drive the Node CLI in-process-free fashion: spawn `node src/cli.mjs looped`.
// This keeps the extension thin (no duplicate fusion logic) and lets the CLI
// own the pi subprocess + artifact writing. We pass run-state via env var to
// avoid argv-length limits.
function runViaCli(objective: string, runState: any, runId: string, runDir: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      LOOPED_FUSION_RUN_STATE: JSON.stringify(runState),
    };
    const proc = spawn('node', ['src/cli.mjs', 'looped', '--config', CONFIG_PATH, '--runDir', runDir, '--runId', runId, '--step', String(runState.loopStep || 1), objective], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`looped CLI exited ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error: any) {
        reject(new Error(`looped CLI returned non-JSON: ${stdout.slice(0, 400)}`));
      }
    });
  });
}

function presentResult(ctx: any, result: any, objective: string) {
  if (result.status !== 'ok') {
    ctx.ui.notify(`Loop Conductor: ${result.summary || 'run failed (see artifacts)'}`, 'warning');
    return;
  }
  const d = result.decision;
  const failed = result.view_errors?.length ? ` | views failed: ${result.view_errors.map((e: any) => e.role).join(', ')}` : '';
  const degraded = result.conductor_notes?.length ? ` | notes: ${result.conductor_notes.join('; ')}` : '';
  ctx.ui.notify(`Loop Conductor: ${d.status} → next ${d.next_pi_agent}${d.next_model_id ? ` (${d.next_model_id})` : ''}${failed}${degraded}`, 'info');

  // Inject the conductor's analysis + next prompt as a context message so the
  // brain model can reason over it. triggerTurn keeps the loop moving.
  const tensions = (d.tensions || [])
    .map((t: any) => `- ${t.topic || 'unnamed'}: ${(t.stances || []).map((s: any) => `${s.pi_agent}: ${s.stance}`).join(' / ')}`)
    .join('\n');
  const risks = (d.risk_flags || []).map((r: string) => `- ${r}`).join('\n');
  const message =
    `Loop Conductor round for: "${objective}"\n\n` +
    `Status: ${d.status}. Next PI agent: ${d.next_pi_agent}${d.next_model_id ? ` (${d.next_model_id})` : ''}.\n` +
    `Handoff reason: ${d.handoff_reason || '(none)'}\n\n` +
    `Consensus:\n${(d.consensus || []).map((c: string) => `- ${c}`).join('\n') || '- (none)'}\n\n` +
    `Tensions:\n${tensions || '- (none)'}\n\n` +
    `Risk flags:\n${risks || '- (none)'}\n\n` +
    `Stop condition: ${d.stop_condition || '(unspecified)'}\n\n` +
    `Next prompt:\n${d.next_prompt}\n\n` +
    `Decide whether to follow this next prompt, modify it, or ignore it. This is a recommendation, not an instruction.`;
  pi.sendMessage({ customType: 'looped-fusion', content: message, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
}

function makeRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-looped-pi-fusion`;
}
