import { chatCompletion } from './openai-compatible.mjs';
import { chatViaPi, createPiClient, needsPi } from './pi-transport.mjs';

export const ANALYSIS_SCHEMA_KEYS = [
  'consensus',
  'contradictions',
  'partial_coverage',
  'unique_insights',
  'blind_spots',
  'judge_notes',
];

export async function runFusion(config, input, options = {}) {
  const prompt = normalizePrompt(input);
  if (!prompt) {
    throw new Error('Fusion needs a non-empty prompt.');
  }
  if (!Array.isArray(config.panel) || config.panel.length === 0) {
    throw new Error('Fusion needs at least one panel model in config.panel.');
  }
  if (!config.judge) {
    throw new Error('Fusion needs a judge model in config.judge.');
  }

  const injectedPiClient = options?.piClient;
  const injectedCall = options?.call;
  const piClient = injectedPiClient ?? (!injectedCall && needsPi(config) ? createPiClient({ timeoutMs: config.timeoutMs }) : null);
  const call = injectedCall || ((modelConfig, messages) => {
    if (modelConfig?.backend === 'pi') {
      return chatViaPi(piClient, modelConfig, messages, { timeoutMs: config.timeoutMs });
    }
    return chatCompletion(modelConfig, messages, { timeoutMs: config.timeoutMs });
  });

  try {
    const panelResult = await runPanel(config, prompt, call);
    if (panelResult.responses.length === 0) {
      return {
        status: 'error',
        final_answer: '',
        analysis: null,
        responses: [],
        failed_models: panelResult.failedModels,
        degradation_reasons: ['All panel models failed.'],
      };
    }

    const degradationReasons = [];
    if (panelResult.failedModels.length > 0) {
      degradationReasons.push('Some panel models failed.');
    }

    const judgeResult = await judgePanel(config, prompt, panelResult.responses, call);
    if (judgeResult.degraded) {
      degradationReasons.push(judgeResult.degraded);
    }

    const synthesisResult = await synthesize(config, prompt, panelResult.responses, judgeResult, call);
    if (synthesisResult.degraded) {
      degradationReasons.push(synthesisResult.degraded);
    }

    return {
      status: 'ok',
      final_answer: synthesisResult.finalAnswer,
      analysis: judgeResult.analysis,
      responses: panelResult.responses,
      failed_models: panelResult.failedModels,
      degradation_reasons: degradationReasons,
      raw_judge_output: judgeResult.rawOutput || undefined,
    };
  } finally {
    if (piClient && !injectedPiClient) {
      await piClient.close();
    }
  }
}

export async function runPanel(config, prompt, call) {
  const runner = (modelConfig) => runPanelModel(config, modelConfig, prompt, call);
  const attempts = config.parallel === false
    ? await runSequential(config.panel, runner)
    : await Promise.all(config.panel.map(runner));

  return {
    responses: attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.response),
    failedModels: attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.failure),
  };
}

async function runSequential(items, fn) {
  const results = [];
  for (const item of items) {
    results.push(await fn(item));
  }
  return results;
}

async function runPanelModel(config, modelConfig, prompt, call) {
  try {
    const messages = [
      {
        role: 'system',
        content: modelConfig.system || defaultPanelSystemPrompt(modelConfig),
      },
      {
        role: 'user',
        content: `Answer independently as one member of a local Fusion panel.\n\nTask:\n${prompt}`,
      },
    ];
    const content = await call(modelConfig, messages);
    if (!content) {
      throw new Error('Empty response');
    }
    return {
      ok: true,
      response: {
        model: modelConfig.name || modelConfig.model,
        content,
      },
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        model: modelConfig.name || modelConfig.model || 'unknown-model',
        error: error?.message || String(error),
      },
    };
  }
}

export async function judgePanel(config, prompt, responses, call) {
  try {
    const rawOutput = await call(
      config.judge,
      [
        {
          role: 'system',
          content: config.judge.system || 'You compare model answers and return strict JSON only.',
        },
        {
          role: 'user',
          content: buildJudgePrompt(prompt, responses),
        },
      ],
    );

    const analysis = parseJudgeAnalysis(rawOutput);
    if (!analysis) {
      return {
        analysis: fallbackAnalysis(responses),
        rawOutput,
        degraded: 'Judge output was not valid JSON; used heuristic analysis.',
      };
    }
    return { analysis, rawOutput, degraded: null };
  } catch (error) {
    return {
      analysis: fallbackAnalysis(responses),
      rawOutput: '',
      degraded: `Judge failed: ${error?.message || String(error)}; used heuristic analysis.`,
    };
  }
}

export async function synthesize(config, prompt, responses, judgeResult, call) {
  const synthesizer = config.synthesizer || config.judge;
  try {
    const finalAnswer = await call(
      synthesizer,
      [
        {
          role: 'system',
          content: synthesizer.system || 'Synthesize the best answer from the panel and judge analysis.',
        },
        {
          role: 'user',
          content: buildSynthesisPrompt(prompt, responses, judgeResult.analysis),
        },
      ],
    );
    if (!finalAnswer) {
      throw new Error('Empty synthesis');
    }
    return { finalAnswer, degraded: null };
  } catch (error) {
    return {
      finalAnswer: responses[0]?.content || '',
      degraded: `Synthesizer failed: ${error?.message || String(error)}; returned first panel answer.`,
    };
  }
}

export function buildJudgePrompt(prompt, responses) {
  return `Compare these local model responses. Do not merge them. Return only JSON with this exact shape:
{
  "consensus": ["points most models agreed on"],
  "contradictions": [
    { "topic": "short topic", "stances": [{ "model": "model name", "stance": "what it said" }] }
  ],
  "partial_coverage": [
    { "models": ["model name"], "point": "point covered by only some models" }
  ],
  "unique_insights": [
    { "model": "model name", "insight": "useful insight only this model raised" }
  ],
  "blind_spots": ["important missing topics"],
  "judge_notes": ["brief guidance for the final synthesizer"]
}

Original task:
${prompt}

Panel responses:
${formatResponses(responses)}`;
}

export function buildSynthesisPrompt(prompt, responses, analysis) {
  return `Use the judge analysis and raw panel responses to write the best final answer.

Original task:
${prompt}

Judge analysis:
${JSON.stringify(analysis, null, 2)}

Raw panel responses:
${formatResponses(responses)}

Final answer requirements:
- Preserve high-confidence consensus.
- Resolve contradictions explicitly when possible.
- Include unique useful insights.
- Call out uncertainty and missing information.
- Be concise unless the task asks for detail.`;
}

export function parseJudgeAnalysis(rawOutput) {
  const text = extractJsonPayload(rawOutput);
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    for (const key of ANALYSIS_SCHEMA_KEYS) {
      if (!Array.isArray(parsed[key])) {
        parsed[key] = [];
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export function extractJsonPayload(rawOutput) {
  const text = String(rawOutput || '').trim();
  if (!text) {
    return '';
  }

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }
  return text;
}

export function fallbackAnalysis(responses) {
  return {
    consensus: responses.length > 1 ? ['Judge unavailable: compare panel answers manually before relying on consensus.'] : [],
    contradictions: [],
    partial_coverage: responses.map((response) => ({
      models: [response.model],
      point: `Panel response available from ${response.model}.`,
    })),
    unique_insights: [],
    blind_spots: ['No structured judge analysis was available.'],
    judge_notes: ['Use raw panel responses conservatively.'],
  };
}

export function formatResponses(responses) {
  return responses.map((response) => `<response model="${escapeAttribute(response.model)}">
${response.content}
</response>`).join('\n\n');
}

function defaultPanelSystemPrompt(modelConfig) {
  return `You are ${modelConfig.name || modelConfig.model}, one model in a local multi-model council. Answer independently. Focus on correctness, tradeoffs, edge cases, and uncertainty.`;
}

function normalizePrompt(input) {
  if (typeof input === 'string') {
    return input.trim();
  }
  if (Array.isArray(input?.messages)) {
    return input.messages
      .filter((message) => message?.role !== 'system')
      .map((message) => stringifyContent(message.content))
      .join('\n')
      .trim();
  }
  return '';
}

function stringifyContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      return part?.text || '';
    }).join('\n');
  }
  return '';
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
