import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPiPrompt } from '../src/pi-transport.mjs';
import { parseJudgeAnalysis, runFusion } from '../src/fusion.mjs';

test('buildPiPrompt prepends no-tool preamble, system, and user content', () => {
  const prompt = buildPiPrompt(
    { system: 'You are a skeptical critic.' },
    [
      { role: 'system', content: 'ignored-role-system' },
      { role: 'user', content: 'Compare A and B.' },
      { role: 'user', content: 'Be brief.' },
    ],
  );
  assert.match(prompt, /Do NOT call any tools/);
  assert.match(prompt, /You are a skeptical critic\./);
  assert.match(prompt, /Compare A and B\.\nBe brief\./);
  assert.equal(prompt.includes('ignored-role-system'), false, 'message-role system must not leak into pi prompt');
});

test('runFusion routes pi-backended models through an injected pi client', async () => {
  const fakePi = makeFakePiClient();
  const result = await runFusion(makePiConfig(), 'What should I build?', { piClient: fakePi });

  assert.equal(result.status, 'ok');
  assert.equal(result.final_answer, 'Fused via subscriptions');
  assert.equal(result.responses.length, 2);
  assert.deepEqual(result.degradation_reasons, []);
  assert.equal(fakePi.calls.length, 4, '2 panel + judge + synth');
  assert.deepEqual(
    fakePi.calls.map((call) => call.provider),
    ['zai', 'openai-codex', 'anthropic', 'openai-codex'],
  );
  assert.equal(fakePi.closeCalls, 0, 'injected client is owned by the caller, not closed by runFusion');
});

test('runFusion mixes openai and pi backends in one run', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(String(url));
    return mockResponse('openai panel answer');
  };
  const fakePi = makeFakePiClient();
  try {
    const result = await runFusion(makeMixedConfig(), 'Compare options', { piClient: fakePi });
    assert.equal(result.status, 'ok');
    assert.equal(result.responses.length, 2);
    assert.equal(fetchCalls.length, 1, 'only the openai panel model hit fetch');
    assert.equal(fakePi.calls.length, 3, 'one pi panel + pi judge + pi synth');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeFakePiClient() {
  const calls = [];
  return {
    calls,
    closeCalls: 0,
    async ask({ provider, modelId, prompt }) {
      calls.push({ provider, modelId, prompt });
      if (modelId === 'claude-opus-4-8') {
        return JSON.stringify({
          consensus: ['Both panel models agreed.'],
          contradictions: [],
          partial_coverage: [],
          unique_insights: [],
          blind_spots: [],
          judge_notes: ['Prefer concrete steps.'],
        });
      }
      if (modelId === 'gpt-5.4') {
        return 'Fused via subscriptions';
      }
      return `answer from ${modelId}`;
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

function makePiConfig() {
  return {
    parallel: true,
    timeoutMs: 1000,
    panel: [
      { name: 'glm52', backend: 'pi', provider: 'zai', modelId: 'glm-5.2', system: 'generalist' },
      { name: 'gpt54', backend: 'pi', provider: 'openai-codex', modelId: 'gpt-5.4', system: 'builder' },
    ],
    judge: { name: 'judge', backend: 'pi', provider: 'anthropic', modelId: 'claude-opus-4-8' },
    synthesizer: { name: 'synth', backend: 'pi', provider: 'openai-codex', modelId: 'gpt-5.4' },
  };
}

function makeMixedConfig() {
  return {
    parallel: true,
    timeoutMs: 1000,
    panel: [
      { name: 'local', baseUrl: 'http://openai-panel.test/v1', apiKey: 'local', model: 'a' },
      { name: 'glm52', backend: 'pi', provider: 'zai', modelId: 'glm-5.2' },
    ],
    judge: { name: 'judge', backend: 'pi', provider: 'anthropic', modelId: 'claude-opus-4-8' },
    synthesizer: { name: 'synth', backend: 'pi', provider: 'openai-codex', modelId: 'gpt-5.4' },
  };
}

test('parseJudgeAnalysis extracts fenced JSON', () => {
  const analysis = parseJudgeAnalysis(`\`\`\`json
{
  "consensus": ["A"],
  "contradictions": [],
  "partial_coverage": [],
  "unique_insights": [],
  "blind_spots": [],
  "judge_notes": ["Use A"]
}
\`\`\``);

  assert.deepEqual(analysis.consensus, ['A']);
  assert.deepEqual(analysis.judge_notes, ['Use A']);
});

test('runFusion calls panel, judge, and synthesizer', async () => {
  await withMockFetch(async (calls) => {
    const result = await runFusion(makeConfig(), 'What should I build?');

    assert.equal(result.status, 'ok');
    assert.equal(result.final_answer, 'Final fused answer');
    assert.equal(result.responses.length, 2);
    assert.deepEqual(result.analysis.consensus, ['Both mention local execution.']);
    assert.deepEqual(result.degradation_reasons, []);
    assert.equal(calls.length, 4);
  }, {
    panelA: 'Use local model A.',
    panelB: 'Use local model B.',
    judge: JSON.stringify({
      consensus: ['Both mention local execution.'],
      contradictions: [],
      partial_coverage: [],
      unique_insights: [{ model: 'panel-a', insight: 'A is faster.' }],
      blind_spots: [],
      judge_notes: ['Prefer concrete setup steps.'],
    }),
    synth: 'Final fused answer',
  });
});

test('runFusion degrades when one panel model fails', async () => {
  await withMockFetch(async () => {
    const result = await runFusion(makeConfig(), 'Compare options');

    assert.equal(result.status, 'ok');
    assert.equal(result.responses.length, 1);
    assert.equal(result.failed_models.length, 1);
    assert.match(result.degradation_reasons.join('\n'), /Some panel models failed/);
    assert.equal(result.final_answer, 'Final fused answer');
  }, {
    panelA: 'Only model A answered.',
    panelBStatus: 500,
    panelB: { error: 'boom' },
    judge: JSON.stringify({
      consensus: [],
      contradictions: [],
      partial_coverage: [],
      unique_insights: [],
      blind_spots: [],
      judge_notes: [],
    }),
    synth: 'Final fused answer',
  });
});

test('runFusion uses heuristic analysis when judge JSON is invalid', async () => {
  await withMockFetch(async () => {
    const result = await runFusion(makeConfig(), 'Compare options');

    assert.equal(result.status, 'ok');
    assert.match(result.degradation_reasons.join('\n'), /Judge output was not valid JSON/);
    assert.deepEqual(result.analysis.blind_spots, ['No structured judge analysis was available.']);
  }, {
    panelA: 'Model A answer',
    panelB: 'Model B answer',
    judge: 'not-json',
    synth: 'Final fused answer',
  });
});

test('runFusion reports error when all panel models fail', async () => {
  await withMockFetch(async () => {
    const result = await runFusion(makeConfig(), 'Compare options');

    assert.equal(result.status, 'error');
    assert.equal(result.responses.length, 0);
    assert.equal(result.failed_models.length, 2);
    assert.match(result.degradation_reasons.join('\n'), /All panel models failed/);
  }, {
    panelAStatus: 500,
    panelA: { error: 'a failed' },
    panelBStatus: 500,
    panelB: { error: 'b failed' },
  });
});

function makeConfig() {
  return {
    parallel: true,
    timeoutMs: 1000,
    panel: [
      {
        name: 'panel-a',
        baseUrl: 'http://panel-a.test/v1',
        apiKey: 'local',
        model: 'a',
      },
      {
        name: 'panel-b',
        baseUrl: 'http://panel-b.test/v1',
        apiKey: 'local',
        model: 'b',
      },
    ],
    judge: {
      name: 'judge',
      baseUrl: 'http://judge.test/v1',
      apiKey: 'local',
      model: 'judge',
    },
    synthesizer: {
      name: 'synth',
      baseUrl: 'http://synth.test/v1',
      apiKey: 'local',
      model: 'synth',
    },
  };
}

function withMockFetch(assertions, fixtures) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes('panel-a')) {
      return mockResponse(fixtures.panelA, fixtures.panelAStatus || 200);
    }
    if (String(url).includes('panel-b')) {
      return mockResponse(fixtures.panelB, fixtures.panelBStatus || 200);
    }
    if (String(url).includes('judge')) {
      return mockResponse(fixtures.judge, fixtures.judgeStatus || 200);
    }
    if (String(url).includes('synth')) {
      return mockResponse(fixtures.synth, fixtures.synthStatus || 200);
    }
    return mockResponse({ error: 'unexpected url' }, 404);
  };

  return Promise.resolve()
    .then(() => assertions(calls))
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function mockResponse(content, status = 200) {
  const body = status >= 400
    ? content
    : {
        choices: [
          {
            message: {
              content,
            },
          },
        ],
      };

  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}
