from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

ANALYSIS_KEYS = (
    "consensus",
    "contradictions",
    "partial_coverage",
    "unique_insights",
    "blind_spots",
    "judge_notes",
)

ChatFn = Callable[[dict[str, Any], list[dict[str, str]], int], str]


class LocalModelError(RuntimeError):
    pass


# Imported after LocalModelError is defined to avoid a circular import
# (pi_transport raises LocalModelError, defined here).
from .pi_transport import chat_via_pi, create_pi_client, needs_pi  # noqa: E402


def load_config(path: str | os.PathLike[str] = "local-fusion.config.json") -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def chat_completion(model_config: dict[str, Any], messages: list[dict[str, str]], timeout_ms: int = 120_000) -> str:
    base_url = str(model_config["baseUrl"]).rstrip("/")
    api_key = _resolve_api_key(model_config)
    body = {
        "model": model_config["model"],
        "messages": messages,
        "temperature": model_config.get("temperature", 0.2),
        "max_tokens": model_config.get("maxTokens"),
        "stream": False,
    }
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise LocalModelError(f"{model_config.get('name', model_config.get('model'))} HTTP {error.code}: {detail}") from error
    except Exception as error:
        raise LocalModelError(f"{model_config.get('name', model_config.get('model'))} failed: {error}") from error

    content = payload.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str):
        raise LocalModelError(f"{model_config.get('name', model_config.get('model'))} returned no message content")
    return content.strip()


def run_fusion(
    config: dict[str, Any],
    prompt_or_request: str | dict[str, Any],
    chat_fn: ChatFn = chat_completion,
    pi_client: Any = None,
) -> dict[str, Any]:
    prompt = _normalize_prompt(prompt_or_request)
    if not prompt:
        raise ValueError("Fusion needs a non-empty prompt.")
    if not config.get("panel"):
        raise ValueError("Fusion needs at least one panel model in config['panel'].")
    if not config.get("judge"):
        raise ValueError("Fusion needs a judge model in config['judge'].")

    timeout_ms = int(config.get("timeoutMs", 120_000))

    injected_pi_client = pi_client is not None
    pi = pi_client if injected_pi_client else (create_pi_client(timeout_ms) if needs_pi(config) else None)

    def call(model_config: dict[str, Any], messages: list[dict[str, str]], timeout_ms: int = timeout_ms) -> str:
        if model_config.get("backend") == "pi":
            return chat_via_pi(pi, model_config, messages, timeout_ms)
        return chat_fn(model_config, messages, timeout_ms)

    try:
        panel_result = _run_panel(config, prompt, call)
        if not panel_result["responses"]:
            return {
                "status": "error",
                "final_answer": "",
                "analysis": None,
                "responses": [],
                "failed_models": panel_result["failed_models"],
                "degradation_reasons": ["All panel models failed."],
            }

        degradation_reasons: list[str] = []
        if panel_result["failed_models"]:
            degradation_reasons.append("Some panel models failed.")

        judge_result = _judge_panel(config, prompt, panel_result["responses"], call)
        if judge_result.get("degraded"):
            degradation_reasons.append(judge_result["degraded"])

        synthesis_result = _synthesize(config, prompt, panel_result["responses"], judge_result["analysis"], call)
        if synthesis_result.get("degraded"):
            degradation_reasons.append(synthesis_result["degraded"])

        return {
            "status": "ok",
            "final_answer": synthesis_result["final_answer"],
            "analysis": judge_result["analysis"],
            "responses": panel_result["responses"],
            "failed_models": panel_result["failed_models"],
            "degradation_reasons": degradation_reasons,
            "raw_judge_output": judge_result.get("raw_output") or None,
        }
    finally:
        if pi is not None and not injected_pi_client:
            pi.close()


def build_judge_prompt(prompt: str, responses: list[dict[str, str]]) -> str:
    return f"""Compare these local model responses. Do not merge them. Return only JSON with this exact shape:
{{
  "consensus": ["points most models agreed on"],
  "contradictions": [
    {{ "topic": "short topic", "stances": [{{ "model": "model name", "stance": "what it said" }}] }}
  ],
  "partial_coverage": [
    {{ "models": ["model name"], "point": "point covered by only some models" }}
  ],
  "unique_insights": [
    {{ "model": "model name", "insight": "useful insight only this model raised" }}
  ],
  "blind_spots": ["important missing topics"],
  "judge_notes": ["brief guidance for the final synthesizer"]
}}

Original task:
{prompt}

Panel responses:
{_format_responses(responses)}"""


def build_synthesis_prompt(prompt: str, responses: list[dict[str, str]], analysis: dict[str, Any]) -> str:
    return f"""Use the judge analysis and raw panel responses to write the best final answer.

Original task:
{prompt}

Judge analysis:
{json.dumps(analysis, indent=2)}

Raw panel responses:
{_format_responses(responses)}

Final answer requirements:
- Preserve high-confidence consensus.
- Resolve contradictions explicitly when possible.
- Include unique useful insights.
- Call out uncertainty and missing information.
- Be concise unless the task asks for detail."""


def parse_judge_analysis(raw_output: str) -> dict[str, Any] | None:
    payload = _extract_json_payload(raw_output)
    if not payload:
        return None
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None
    for key in ANALYSIS_KEYS:
        if not isinstance(parsed.get(key), list):
            parsed[key] = []
    return parsed


def _run_panel(config: dict[str, Any], prompt: str, chat_fn: ChatFn) -> dict[str, Any]:
    timeout_ms = int(config.get("timeoutMs", 120_000))
    panel = list(config["panel"])
    if config.get("parallel", True) is False:
        attempts = [_run_panel_model(model, prompt, timeout_ms, chat_fn) for model in panel]
    else:
        attempts = []
        with ThreadPoolExecutor(max_workers=len(panel)) as executor:
            futures = {executor.submit(_run_panel_model, model, prompt, timeout_ms, chat_fn): model for model in panel}
            for future in as_completed(futures):
                attempts.append(future.result())

    responses_by_model = {attempt["response"]["model"]: attempt["response"] for attempt in attempts if attempt["ok"]}
    failures_by_model = {attempt["failure"]["model"]: attempt["failure"] for attempt in attempts if not attempt["ok"]}
    return {
        "responses": [responses_by_model[(model.get("name") or model.get("model"))] for model in panel if (model.get("name") or model.get("model")) in responses_by_model],
        "failed_models": [failures_by_model[(model.get("name") or model.get("model"))] for model in panel if (model.get("name") or model.get("model")) in failures_by_model],
    }


def _run_panel_model(model_config: dict[str, Any], prompt: str, timeout_ms: int, chat_fn: ChatFn) -> dict[str, Any]:
    model_name = model_config.get("name", model_config.get("model", "unknown-model"))
    try:
        messages = [
            {
                "role": "system",
                "content": model_config.get("system") or f"You are {model_name}, one model in a local multi-model council. Answer independently. Focus on correctness, tradeoffs, edge cases, and uncertainty.",
            },
            {
                "role": "user",
                "content": f"Answer independently as one member of a local Fusion panel.\n\nTask:\n{prompt}",
            },
        ]
        content = chat_fn(model_config, messages, timeout_ms).strip()
        if not content:
            raise LocalModelError("Empty response")
        return {"ok": True, "response": {"model": model_name, "content": content}}
    except Exception as error:
        return {"ok": False, "failure": {"model": model_name, "error": str(error)}}


def _judge_panel(config: dict[str, Any], prompt: str, responses: list[dict[str, str]], chat_fn: ChatFn) -> dict[str, Any]:
    timeout_ms = int(config.get("timeoutMs", 120_000))
    judge = config["judge"]
    try:
        raw_output = chat_fn(
            judge,
            [
                {"role": "system", "content": judge.get("system", "You compare model answers and return strict JSON only.")},
                {"role": "user", "content": build_judge_prompt(prompt, responses)},
            ],
            timeout_ms,
        )
        analysis = parse_judge_analysis(raw_output)
        if analysis is None:
            return {
                "analysis": _fallback_analysis(responses),
                "raw_output": raw_output,
                "degraded": "Judge output was not valid JSON; used heuristic analysis.",
            }
        return {"analysis": analysis, "raw_output": raw_output, "degraded": None}
    except Exception as error:
        return {
            "analysis": _fallback_analysis(responses),
            "raw_output": "",
            "degraded": f"Judge failed: {error}; used heuristic analysis.",
        }


def _synthesize(
    config: dict[str, Any],
    prompt: str,
    responses: list[dict[str, str]],
    analysis: dict[str, Any],
    chat_fn: ChatFn,
) -> dict[str, str | None]:
    timeout_ms = int(config.get("timeoutMs", 120_000))
    synthesizer = config.get("synthesizer") or config["judge"]
    try:
        final_answer = chat_fn(
            synthesizer,
            [
                {"role": "system", "content": synthesizer.get("system", "Synthesize the best answer from the panel and judge analysis.")},
                {"role": "user", "content": build_synthesis_prompt(prompt, responses, analysis)},
            ],
            timeout_ms,
        ).strip()
        if not final_answer:
            raise LocalModelError("Empty synthesis")
        return {"final_answer": final_answer, "degraded": None}
    except Exception as error:
        return {
            "final_answer": responses[0]["content"],
            "degraded": f"Synthesizer failed: {error}; returned first panel answer.",
        }


def _fallback_analysis(responses: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "consensus": ["Judge unavailable: compare panel answers manually before relying on consensus."] if len(responses) > 1 else [],
        "contradictions": [],
        "partial_coverage": [{"models": [response["model"]], "point": f"Panel response available from {response['model']}."} for response in responses],
        "unique_insights": [],
        "blind_spots": ["No structured judge analysis was available."],
        "judge_notes": ["Use raw panel responses conservatively."],
    }


def _format_responses(responses: list[dict[str, str]]) -> str:
    return "\n\n".join(f'<response model="{_escape_attr(response["model"])}">\n{response["content"]}\n</response>' for response in responses)


def _extract_json_payload(raw_output: str) -> str:
    return extract_json_payload(raw_output)


def extract_json_payload(raw_output: str) -> str:
    text = str(raw_output or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 2:
            if lines[-1].strip() == "```":
                lines = lines[:-1]
            return "\n".join(lines[1:]).strip()
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        return text[first:last + 1]
    return text


def _normalize_prompt(prompt_or_request: str | dict[str, Any]) -> str:
    if isinstance(prompt_or_request, str):
        return prompt_or_request.strip()
    messages = prompt_or_request.get("messages", [])
    return "\n".join(_stringify_content(message.get("content", "")) for message in messages if message.get("role") != "system").strip()


def _stringify_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part if isinstance(part, str) else str(part.get("text", "")) for part in content)
    return ""


def _resolve_api_key(model_config: dict[str, Any]) -> str:
    api_key_env = model_config.get("apiKeyEnv")
    if api_key_env:
        return os.environ.get(api_key_env, model_config.get("apiKey", "local"))
    return model_config.get("apiKey", "local")


def _escape_attr(value: str) -> str:
    return str(value).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
