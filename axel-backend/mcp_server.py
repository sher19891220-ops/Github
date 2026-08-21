#!/usr/bin/env python3
"""
Axel MCP server — exposes all Axel tools to Claude Code sessions.

One-time setup on Mac mini:
  bash ~/Github/setup_claude_mcp.sh

After setup, every Claude Code session on the Mac mini gets all Axel tools:
  run_shell, read_file, write_file, memory, tasks, gmail, drive, calendar,
  sheets, bank_accounts, quickbooks, outlook, docker, research, telegram, etc.
"""

import sys
import json
import os
import logging

logging.disable(logging.CRITICAL)  # MCP uses stdout for protocol

_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(_dir)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_dir, ".env"))
except ImportError:
    pass

from db import init_db
init_db()

from tool_registry import TOOLS, dispatch


def _send(obj):
    print(json.dumps(obj), flush=True)


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue

        method = req.get("method", "")
        rid = req.get("id")

        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "axel", "version": "1.0.0"},
            }})

        elif method == "notifications/initialized":
            pass

        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "tools": [
                    {"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]}
                    for t in TOOLS
                ]
            }})

        elif method == "tools/call":
            params = req.get("params", {})
            try:
                result_str = dispatch(params.get("name", ""), params.get("arguments", {}), {})
                _send({"jsonrpc": "2.0", "id": rid, "result": {
                    "content": [{"type": "text", "text": result_str}]
                }})
            except Exception as e:
                _send({"jsonrpc": "2.0", "id": rid, "result": {
                    "content": [{"type": "text", "text": json.dumps({"error": str(e)})}]
                }})

        elif rid is not None:
            _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Method not found: {method}"}})


if __name__ == "__main__":
    main()
