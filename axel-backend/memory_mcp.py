"""
Standalone MCP server exposing Axel's SQLite memory to Claude Code sessions.
Add to .claude/settings.json under mcpServers as "axel-memory".
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from tools.memory import (
    save_memory, get_memory, search_memory, list_memory, delete_memory,
    remember_this, recall, list_rich_memories, forget_memory, get_memory_categories,
)


def _respond(id_, result):
    msg = {"jsonrpc": "2.0", "id": id_, "result": result}
    line = json.dumps(msg)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _error(id_, code, message):
    msg = {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


TOOLS = [
    {
        "name": "save_memory",
        "description": "Save a key-value memory fact.",
        "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}, "value": {"type": "string"}, "category": {"type": "string"}}, "required": ["key", "value"]},
    },
    {
        "name": "get_memory",
        "description": "Get a memory by key.",
        "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]},
    },
    {
        "name": "search_memory",
        "description": "Search memories by keyword (searches both key-value and rich memories).",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "list_memory",
        "description": "List key-value memories, optionally filtered by category.",
        "inputSchema": {"type": "object", "properties": {"category": {"type": "string"}}},
    },
    {
        "name": "delete_memory",
        "description": "Delete a key-value memory by key.",
        "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]},
    },
    {
        "name": "remember_this",
        "description": "Save a rich natural-language memory with category, tags, and importance (1-5).",
        "inputSchema": {"type": "object", "properties": {"content": {"type": "string"}, "category": {"type": "string"}, "tags": {"type": "string"}, "importance": {"type": "integer"}}, "required": ["content"]},
    },
    {
        "name": "recall",
        "description": "Search rich memories by keyword, ordered by importance.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "category": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]},
    },
    {
        "name": "list_rich_memories",
        "description": "List rich memories, optionally filtered by category.",
        "inputSchema": {"type": "object", "properties": {"category": {"type": "string"}, "limit": {"type": "integer"}}},
    },
    {
        "name": "forget_memory",
        "description": "Delete a rich memory by ID.",
        "inputSchema": {"type": "object", "properties": {"memory_id": {"type": "integer"}}, "required": ["memory_id"]},
    },
    {
        "name": "get_memory_categories",
        "description": "List all memory categories with counts.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def handle(request: dict):
    method = request.get("method")
    id_ = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        _respond(id_, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "axel-memory", "version": "1.0.0"},
        })
    elif method == "tools/list":
        _respond(id_, {"tools": TOOLS})
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments", {})
        try:
            match name:
                case "save_memory":
                    result = save_memory(args["key"], args["value"], args.get("category", "general"))
                case "get_memory":
                    result = get_memory(args["key"])
                case "search_memory":
                    result = search_memory(args["query"])
                case "list_memory":
                    result = list_memory(args.get("category", ""))
                case "delete_memory":
                    result = delete_memory(args["key"])
                case "remember_this":
                    result = remember_this(args["content"], args.get("category", "general"), args.get("tags", ""), args.get("source", "claude-code"), args.get("importance", 3))
                case "recall":
                    result = recall(args["query"], args.get("category", ""), args.get("limit", 20))
                case "list_rich_memories":
                    result = list_rich_memories(args.get("category", ""), args.get("limit", 50))
                case "forget_memory":
                    result = forget_memory(args["memory_id"])
                case "get_memory_categories":
                    result = get_memory_categories()
                case _:
                    _error(id_, -32601, f"Unknown tool: {name}")
                    return
            _respond(id_, {"content": [{"type": "text", "text": json.dumps(result)}]})
        except Exception as e:
            _error(id_, -32603, str(e))
    elif method == "notifications/initialized":
        pass  # no response needed
    else:
        if id_ is not None:
            _error(id_, -32601, f"Method not found: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        handle(request)


if __name__ == "__main__":
    main()
