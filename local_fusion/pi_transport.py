"""Pi-subscription transport (mirror of src/pi-transport.mjs).

When a model config has ``backend: "pi"``, local-fusion drives a headless Pi
subprocess (``pi --mode rpc --no-session``) instead of POSTing to an
OpenAI-compatible URL. Pi owns the auth (including OAuth subscriptions such as
ChatGPT/Claude Pro), so local-fusion needs no API keys of its own for these
models — it only spawns ``pi``, which uses ``~/.pi/agent/auth.json``.

One Pi subprocess is shared across every pi-backend call in a single
``run_fusion`` run; we switch models with ``set_model`` and collect each reply
from the streamed ``text_delta`` events.
"""

from __future__ import annotations

import itertools
import json
import queue
import subprocess
import threading
import time
from typing import Any, Callable

from .core import LocalModelError

# Suppress tool use: Pi's coding agent has read/bash/edit/write active, and
# without this preamble a code-flavoured question tempts the model into
# exploring the repo (extra turns, nondeterministic, repo-grounded instead of
# independent). This keeps every panel member a single deterministic prose turn.
NO_TOOL_PREAMBLE = (
    "Answer directly from your own knowledge in prose only. Do NOT call any tools "
    "(read, bash, edit, write, grep, or any other) and do not inspect files. "
    "Output only the requested content, with no preamble or meta-commentary."
)


def build_pi_prompt(model_config: dict[str, Any], messages: list[dict[str, Any]]) -> str:
    system = str(model_config.get("system", "") or "").strip()
    user = "\n".join(
        _stringify_content(message.get("content", ""))
        for message in messages
        if message.get("role") == "user"
    ).strip()
    parts: list[str] = [NO_TOOL_PREAMBLE]
    if system:
        parts.append(system)
    if user:
        parts.append(user)
    return "\n\n".join(parts)


def needs_pi(config: dict[str, Any]) -> bool:
    entries = list(config.get("panel") or [])
    if config.get("judge"):
        entries.append(config["judge"])
    if config.get("synthesizer"):
        entries.append(config["synthesizer"])
    return any(bool(entry) and entry.get("backend") == "pi" for entry in entries)


def chat_via_pi(
    client: "_PiClient | Any",
    model_config: dict[str, Any],
    messages: list[dict[str, Any]],
    timeout_ms: int,
) -> str:
    if client is None:
        raise LocalModelError("pi backend selected but no pi client was provided")
    provider = model_config.get("provider")
    model_id = model_config.get("modelId")
    if not provider or not model_id:
        raise LocalModelError(
            f"pi backend needs both 'provider' and 'modelId' (model {model_config.get('name') or model_config.get('model') or '?'})"
        )
    prompt = build_pi_prompt(model_config, messages)
    return client.ask(provider, model_id, prompt, timeout_ms)


class _PiClient:
    def __init__(self, timeout_ms: int = 120_000) -> None:
        self.timeout_ms = timeout_ms
        self.proc = subprocess.Popen(
            ["pi", "--mode", "rpc", "--no-session"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._queue: queue.Queue[Any] = queue.Queue()
        self._closed = False
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.rstrip("\n").rstrip("\r")
            if not line.strip():
                continue
            try:
                self._queue.put(json.loads(line))
            except json.JSONDecodeError:
                continue
        self._queue.put(None)  # EOF sentinel

    def _send(self, command: dict[str, Any]) -> str:
        assert self.proc.stdin is not None
        command_id = str(next(self._ids))
        payload = json.dumps({"id": command_id, **command})
        self.proc.stdin.write(payload + "\n")
        self.proc.stdin.flush()
        return command_id

    def ask(self, provider: str, model_id: str, prompt: str, timeout_ms: int | None = None) -> str:
        # One Pi subprocess serves every pi-backend call in a run; its JSONL
        # stdin/stdout can only carry one command at a time, so serialize asks.
        with self._lock:
            return self._ask_raw(provider, model_id, prompt, timeout_ms)

    def _ask_raw(self, provider: str, model_id: str, prompt: str, timeout_ms: int | None) -> str:
        if self._closed:
            raise LocalModelError("pi client is closed")
        seconds = (timeout_ms or self.timeout_ms) / 1000
        set_id = self._send({"type": "set_model", "provider": provider, "modelId": model_id})
        self._await_response(set_id, seconds, "set_model", provider, model_id)
        prompt_id = self._send({"type": "prompt", "message": prompt})
        return self._collect_prompt(prompt_id, seconds, provider, model_id)

    def _await_response(self, command_id: str, seconds: float, label: str, provider: str, model_id: str) -> None:
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LocalModelError(f"pi rpc '{label}' timed out after {seconds * 1000:.0f}ms")
            try:
                obj = self._queue.get(timeout=remaining)
            except queue.Empty:
                raise LocalModelError(f"pi rpc '{label}' timed out after {seconds * 1000:.0f}ms")
            if obj is None:
                raise LocalModelError("pi rpc subprocess exited unexpectedly")
            if obj.get("type") == "response" and obj.get("id") == command_id:
                if obj.get("success") is False:
                    raise LocalModelError(f"pi {label} failed for {provider}/{model_id}: {obj.get('error', 'unknown error')}")
                return

    def _collect_prompt(self, prompt_id: str, seconds: float, provider: str, model_id: str) -> str:
        deadline = time.monotonic() + seconds
        text: list[str] = []
        ended = False
        last_assistant: dict[str, Any] | None = None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LocalModelError(f"pi rpc prompt timed out after {seconds * 1000:.0f}ms")
            try:
                obj = self._queue.get(timeout=remaining)
            except queue.Empty:
                raise LocalModelError(f"pi rpc prompt timed out after {seconds * 1000:.0f}ms")
            if obj is None:
                raise LocalModelError("pi rpc subprocess exited unexpectedly")
            if obj.get("type") == "message_update":
                event = obj.get("assistantMessageEvent") or {}
                if event.get("type") == "text_delta":
                    text.append(event.get("delta", ""))
            if obj.get("type") == "message_end":
                message = obj.get("message") or {}
                if message.get("role") == "assistant":
                    last_assistant = message
            if obj.get("type") == "agent_end":
                ended = True
            if obj.get("type") == "response" and obj.get("id") == prompt_id:
                if obj.get("success") is False:
                    raise LocalModelError(f"pi prompt rejected for {provider}/{model_id}: {obj.get('error', 'unknown error')}")
                if not ended:
                    continue
                break
        if last_assistant and (last_assistant.get("stopReason") == "error" or last_assistant.get("errorMessage")):
            raise LocalModelError(
                f"pi rpc {provider}/{model_id} returned an error: {last_assistant.get('errorMessage') or last_assistant.get('stopReason')}"
            )
        result = "".join(text).strip()
        if not result and isinstance(last_assistant, dict):
            result = "\n".join(
                block.get("text", "")
                for block in last_assistant.get("content", [])
                if isinstance(block, dict) and block.get("type") == "text"
            ).strip()
        if not result:
            raise LocalModelError(f"pi rpc returned no text for {provider}/{model_id}")
        return result

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            assert self.proc.stdin is not None
            self.proc.stdin.close()
        except Exception:
            pass
        time.sleep(0.1)
        try:
            self.proc.terminate()
        except Exception:
            pass


def create_pi_client(timeout_ms: int = 120_000) -> _PiClient:
    return _PiClient(timeout_ms=timeout_ms)


def _stringify_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part if isinstance(part, str) else str(part.get("text", "")) for part in content)
    return ""
