const DEFAULT_TIMEOUT_MS = 120000;

export class LocalModelError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LocalModelError';
    this.details = details;
  }
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

export async function chatCompletion(modelConfig, messages, options = {}) {
  const timeoutMs = options.timeoutMs ?? modelConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${normalizeBaseUrl(modelConfig.baseUrl)}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolveApiKey(modelConfig)}`,
      },
      body: JSON.stringify({
        model: modelConfig.model,
        messages,
        temperature: modelConfig.temperature ?? options.temperature ?? 0.2,
        max_tokens: modelConfig.maxTokens ?? options.maxTokens,
        stream: false,
      }),
    });

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new LocalModelError(`Model ${modelConfig.name} returned non-JSON HTTP ${response.status}`, {
        status: response.status,
        body: text.slice(0, 1000),
      });
    }

    if (!response.ok) {
      throw new LocalModelError(`Model ${modelConfig.name} failed with HTTP ${response.status}`, {
        status: response.status,
        body: json,
      });
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LocalModelError(`Model ${modelConfig.name} returned no message content`, { body: json });
    }
    return content.trim();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new LocalModelError(`Model ${modelConfig.name} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveApiKey(modelConfig) {
  if (modelConfig.apiKeyEnv) {
    return process.env[modelConfig.apiKeyEnv] || modelConfig.apiKey || 'local';
  }
  return modelConfig.apiKey || 'local';
}
