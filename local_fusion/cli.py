from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .core import load_config, run_fusion
from .looped import run_looped_fusion
from .pi_transport import create_pi_client


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="local-fusion")
    subcommands = parser.add_subparsers(dest="command", required=True)

    ask_parser = subcommands.add_parser("ask", help="Run one Fusion prompt")
    ask_parser.add_argument("prompt", nargs="*", help="Prompt text. Reads stdin when omitted.")
    ask_parser.add_argument("--config", default="local-fusion.config.json")
    ask_parser.add_argument("--json", action="store_true", help="Print the full Fusion trace")

    looped_parser = subcommands.add_parser("looped", help="Run one Loop Conductor round")
    looped_parser.add_argument("objective", nargs="*", help="Objective text.")
    looped_parser.add_argument("--config", default="looped-fusion.config.json")
    looped_parser.add_argument("--run-dir", dest="run_dir", default=None)
    looped_parser.add_argument("--step", type=int, default=1)
    looped_parser.add_argument("--run-id", dest="run_id", default=None)

    serve_parser = subcommands.add_parser("serve", help="Run an OpenAI-compatible local server")
    serve_parser.add_argument("--config", default="local-fusion.config.json")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8787)

    args = parser.parse_args(argv)
    if args.command == "ask":
        return ask(args)
    if args.command == "looped":
        return looped(args)
    if args.command == "serve":
        return serve(args)
    return 1


def ask(args: argparse.Namespace) -> int:
    prompt = " ".join(args.prompt).strip() or sys.stdin.read().strip()
    config = load_config(args.config)
    result = run_fusion(config, prompt)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result.get("degradation_reasons"):
            print(f"Degraded: {' | '.join(result['degradation_reasons'])}", file=sys.stderr)
        print(result["final_answer"])
    return 0


def looped(args: argparse.Namespace) -> int:
    objective = " ".join(args.objective).strip()
    if not objective:
        print("looped needs an objective: python3 -m local_fusion looped \"<objective>\"", file=sys.stderr)
        return 1
    config = load_config(args.config)
    if not config.get("model_roster") or not config.get("role_model_policy"):
        print("looped needs model_roster and role_model_policy in the config (see looped-fusion.config.json).", file=sys.stderr)
        return 1

    run_state = {
        "loopStep": args.step,
        "heartbeat": "fresh",
    }

    pi_client = create_pi_client(config.get("timeoutMs", 120_000))

    def call(model_config: dict[str, Any], messages: list[dict[str, str]]) -> str:
        from .pi_transport import chat_via_pi
        return chat_via_pi(pi_client, model_config, messages, config.get("timeoutMs", 120_000))

    try:
        result = run_looped_fusion(config, objective, run_state, call, run_id=args.run_id, run_dir=args.run_dir)
        print(json.dumps(result, indent=2))
        return 0 if result.get("status") == "ok" else 1
    finally:
        pi_client.close()


def serve(args: argparse.Namespace) -> int:
    config_path = args.config

    class Handler(BaseHTTPRequestHandler):
        server_version = "local-fusion/0.1"

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send_json(200, {"ok": True})
            else:
                self._send_json(404, {"error": {"message": "Not found"}})

        def do_POST(self) -> None:
            if self.path != "/v1/chat/completions":
                self._send_json(404, {"error": {"message": "Not found"}})
                return

            try:
                request_body = self._read_json()
                config = load_config(config_path)
                result = run_fusion(config, {"messages": request_body.get("messages", [])})
                self._send_json(
                    200,
                    {
                        "id": "local-fusion",
                        "object": "chat.completion",
                        "created": 0,
                        "model": request_body.get("model", "local/fusion"),
                        "choices": [
                            {
                                "index": 0,
                                "finish_reason": "stop",
                                "message": {
                                    "role": "assistant",
                                    "content": result["final_answer"],
                                },
                            }
                        ],
                        "local_fusion": result,
                    },
                )
            except Exception as error:
                self._send_json(500, {"error": {"message": str(error), "type": "local_fusion_error"}})

        def log_message(self, format: str, *args: Any) -> None:
            print(f"{self.address_string()} - {format % args}", file=sys.stderr)

        def _read_json(self) -> dict[str, Any]:
            content_length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(content_length).decode("utf-8")
            return json.loads(raw or "{}")

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload, indent=2).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"local-fusion listening on http://{args.host}:{args.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nlocal-fusion stopped", file=sys.stderr)
    finally:
        server.server_close()
    return 0
