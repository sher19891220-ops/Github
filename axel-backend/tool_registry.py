"""
Central registry: Claude tool definitions + dispatcher.
Add new tools here — one entry in TOOLS, one branch in dispatch().
"""

import json

from tools import (
    docker_tools,
    finance_tools,
    google_tools,
    memory,
    microsoft_tools,
    notifications,
    research,
    scheduler,
    system,
    tasks,
)

# ── Tool definitions (sent to Claude) ─────────────────────────────────────────

TOOLS = [
    # SYSTEM
    {
        "name": "run_shell",
        "description": "Execute a shell command on the Mac mini. Returns stdout, stderr, and exit code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run"},
                "timeout": {"type": "integer", "description": "Max seconds to wait (default 30)"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file on the Mac mini.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Absolute or ~ path to the file"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file on the Mac mini. Creates directories if needed.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "list_directory",
        "description": "List files and directories at a path on the Mac mini.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "search_files",
        "description": "Find files matching a glob pattern under a directory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern e.g. '*.py'"},
                "directory": {"type": "string", "description": "Base directory to search (default: ~)"},
            },
            "required": ["pattern"],
        },
    },

    # TASKS
    {
        "name": "create_task",
        "description": "Create a task in AXEL task list.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                "due_date": {"type": "string", "description": "YYYY-MM-DD format"},
            },
            "required": ["title"],
        },
    },
    {
        "name": "list_tasks",
        "description": "List tasks filtered by status.",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["open", "done", "cancelled"], "description": "Default: open"},
            },
        },
    },
    {
        "name": "complete_task",
        "description": "Mark a task as done by its ID.",
        "input_schema": {
            "type": "object",
            "properties": {"task_id": {"type": "integer"}},
            "required": ["task_id"],
        },
    },
    {
        "name": "update_task",
        "description": "Update fields on an existing task.",
        "input_schema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "integer"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "priority": {"type": "string"},
                "due_date": {"type": "string"},
                "status": {"type": "string"},
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "get_task",
        "description": "Get full details of a task by ID.",
        "input_schema": {
            "type": "object",
            "properties": {"task_id": {"type": "integer"}},
            "required": ["task_id"],
        },
    },

    # MEMORY
    {
        "name": "save_memory",
        "description": "Persist a fact about Sher, his businesses, projects, contacts, or preferences. Use this to remember anything Sher tells you.",
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Unique identifier e.g. 'sher.preferred_model' or 'truck.unit_12.driver'"},
                "value": {"type": "string"},
                "category": {"type": "string", "description": "profile | business | project | system | contact | recurring"},
            },
            "required": ["key", "value"],
        },
    },
    {
        "name": "get_memory",
        "description": "Retrieve a stored fact by its exact key.",
        "input_schema": {
            "type": "object",
            "properties": {"key": {"type": "string"}},
            "required": ["key"],
        },
    },
    {
        "name": "search_memory",
        "description": "Search stored memories by keyword. Use before asking Sher for information — it may already be stored.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "list_memory",
        "description": "List all stored memories, optionally filtered by category.",
        "input_schema": {
            "type": "object",
            "properties": {"category": {"type": "string", "description": "Optional: profile | business | project | system | contact | recurring"}},
        },
    },

    # RESEARCH
    {
        "name": "search_web",
        "description": "Search the web using DuckDuckGo. Returns titles, URLs, and snippets.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "max_results": {"type": "integer", "description": "Default 8"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "search_news",
        "description": "Search for recent news on a topic.",
        "input_schema": {
            "type": "object",
            "properties": {
                "topic": {"type": "string"},
                "max_results": {"type": "integer"},
            },
            "required": ["topic"],
        },
    },
    {
        "name": "fetch_url",
        "description": "Fetch and extract readable text content from a URL.",
        "input_schema": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    },

    # DOCKER
    {
        "name": "docker_list",
        "description": "List all Docker containers on the Mac mini (running and stopped).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "docker_exec",
        "description": "Execute a command inside a Docker container.",
        "input_schema": {
            "type": "object",
            "properties": {
                "container_name": {"type": "string"},
                "command": {"type": "string"},
            },
            "required": ["container_name", "command"],
        },
    },
    {
        "name": "docker_logs",
        "description": "Get recent logs from a Docker container.",
        "input_schema": {
            "type": "object",
            "properties": {
                "container_name": {"type": "string"},
                "lines": {"type": "integer", "description": "Number of log lines (default 50)"},
            },
            "required": ["container_name"],
        },
    },
    {
        "name": "docker_start",
        "description": "Start a stopped Docker container.",
        "input_schema": {
            "type": "object",
            "properties": {"container_name": {"type": "string"}},
            "required": ["container_name"],
        },
    },
    {
        "name": "docker_stop",
        "description": "Stop a running Docker container.",
        "input_schema": {
            "type": "object",
            "properties": {"container_name": {"type": "string"}},
            "required": ["container_name"],
        },
    },

    # NOTIFICATIONS & SCHEDULING
    {
        "name": "send_telegram",
        "description": "Send a proactive message to Sher on Telegram (for updates, alerts, results of async tasks).",
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    {
        "name": "schedule_message",
        "description": "Schedule a Telegram message to be sent to Sher at a specific future time.",
        "input_schema": {
            "type": "object",
            "properties": {
                "message": {"type": "string"},
                "fire_at": {"type": "string", "description": "ISO datetime: YYYY-MM-DD HH:MM:SS"},
            },
            "required": ["message", "fire_at"],
        },
    },
    {
        "name": "list_scheduled",
        "description": "List all pending scheduled messages.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "cancel_scheduled",
        "description": "Cancel a scheduled message by its ID.",
        "input_schema": {
            "type": "object",
            "properties": {"scheduled_id": {"type": "integer"}},
            "required": ["scheduled_id"],
        },
    },

    # GMAIL
    {
        "name": "gmail_list",
        "description": "List Gmail emails. Supports Gmail search syntax: from:x, to:x, is:unread, subject:x, after:2024/1/1, has:attachment, label:x",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Gmail search query (empty = all inbox)"},
                "max_results": {"type": "integer", "description": "Max emails to return (default 20)"},
            },
        },
    },
    {
        "name": "gmail_read",
        "description": "Read the full content of a Gmail email by its message ID (obtained from gmail_list).",
        "input_schema": {
            "type": "object",
            "properties": {"message_id": {"type": "string"}},
            "required": ["message_id"],
        },
    },
    {
        "name": "gmail_send",
        "description": "Send an email from Sher's Gmail account.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Recipient email address"},
                "subject": {"type": "string"},
                "body": {"type": "string", "description": "Email body text"},
                "cc": {"type": "string", "description": "CC email address (optional)"},
            },
            "required": ["to", "subject", "body"],
        },
    },

    # GOOGLE SHEETS
    {
        "name": "sheets_read",
        "description": "Read data from a Google Sheet. Returns all rows formatted as a table.",
        "input_schema": {
            "type": "object",
            "properties": {
                "spreadsheet_id": {"type": "string", "description": "Sheet ID from the URL (the long string between /d/ and /edit)"},
                "range_notation": {"type": "string", "description": "e.g. 'Sheet1!A1:Z100' or just 'Sheet1'. Defaults to all data."},
            },
            "required": ["spreadsheet_id"],
        },
    },
    {
        "name": "sheets_write",
        "description": "Write data to a Google Sheet.",
        "input_schema": {
            "type": "object",
            "properties": {
                "spreadsheet_id": {"type": "string"},
                "range_notation": {"type": "string", "description": "e.g. 'Sheet1!A1'"},
                "values": {
                    "type": "array",
                    "description": "List of rows, each row is a list of cell values",
                    "items": {"type": "array", "items": {}},
                },
            },
            "required": ["spreadsheet_id", "range_notation", "values"],
        },
    },
    {
        "name": "sheets_list",
        "description": "List all Google Sheets in Sher's Drive.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Optional name filter"}},
        },
    },

    # GOOGLE CALENDAR
    {
        "name": "calendar_list",
        "description": "List upcoming Google Calendar events.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days_ahead": {"type": "integer", "description": "How many days ahead to look (default 7)"},
                "max_results": {"type": "integer", "description": "Max events (default 20)"},
            },
        },
    },
    {
        "name": "calendar_create",
        "description": "Create a Google Calendar event.",
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "Event title"},
                "start_datetime": {"type": "string", "description": "ISO format: 2024-01-15T10:00:00"},
                "end_datetime": {"type": "string", "description": "ISO format: 2024-01-15T11:00:00"},
                "description": {"type": "string"},
                "location": {"type": "string"},
                "attendees": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of attendee email addresses",
                },
            },
            "required": ["summary", "start_datetime", "end_datetime"],
        },
    },

    # GOOGLE DRIVE
    {
        "name": "drive_list",
        "description": "List files in Sher's Google Drive.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Filename search filter"},
                "max_results": {"type": "integer", "description": "Default 20"},
                "mime_filter": {"type": "string", "description": "e.g. 'application/pdf' or 'application/vnd.google-apps.document'"},
            },
        },
    },
    {
        "name": "drive_read",
        "description": "Read content of a Google Drive file (Docs, Sheets, text files).",
        "input_schema": {
            "type": "object",
            "properties": {"file_id": {"type": "string", "description": "File ID from drive_list"}},
            "required": ["file_id"],
        },
    },

    # BANK (PLAID)
    {
        "name": "bank_accounts",
        "description": "Get all connected bank accounts with current and available balances.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "bank_transactions",
        "description": "Get bank transactions from the past N days. Shows spending, income, and net.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Days to look back (default 30)"},
                "account_id": {"type": "string", "description": "Filter to specific account (optional)"},
                "category": {"type": "string", "description": "Filter by category keyword (optional)"},
            },
        },
    },

    # QUICKBOOKS
    {
        "name": "qb_invoices",
        "description": "Get QuickBooks invoices with totals, balances, and customer info.",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["Open", "Paid"], "description": "Filter by payment status"},
                "days": {"type": "integer", "description": "Look back N days (default 90)"},
            },
        },
    },
    {
        "name": "qb_expenses",
        "description": "Get QuickBooks expenses and purchases from the past N days.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Days to look back (default 30)"},
            },
        },
    },
    {
        "name": "qb_profit_loss",
        "description": "Get QuickBooks Profit & Loss report for a date range. Defaults to current month.",
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "YYYY-MM-DD (defaults to first of current month)"},
                "end_date": {"type": "string", "description": "YYYY-MM-DD (defaults to today)"},
            },
        },
    },
    {
        "name": "qb_customers",
        "description": "List QuickBooks customers with contact info and outstanding balances.",
        "input_schema": {
            "type": "object",
            "properties": {"search": {"type": "string", "description": "Optional name filter"}},
        },
    },

    # OUTLOOK
    {
        "name": "outlook_list",
        "description": "List Outlook/Microsoft emails.",
        "input_schema": {
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "inbox, sentitems, drafts, deleteditems (default: inbox)"},
                "max_results": {"type": "integer", "description": "Default 20"},
                "filter_unread": {"type": "boolean", "description": "Only show unread emails"},
                "search": {"type": "string", "description": "Keyword search in subject/body"},
            },
        },
    },
    {
        "name": "outlook_read",
        "description": "Read full content of an Outlook email by ID (from outlook_list).",
        "input_schema": {
            "type": "object",
            "properties": {"message_id": {"type": "string"}},
            "required": ["message_id"],
        },
    },
    {
        "name": "outlook_send",
        "description": "Send an email from Sher's Outlook/Microsoft account.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Recipient email address"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "cc": {"type": "string", "description": "CC email (optional)"},
                "importance": {"type": "string", "enum": ["normal", "high", "low"], "description": "Default: normal"},
            },
            "required": ["to", "subject", "body"],
        },
    },
    {
        "name": "outlook_reply",
        "description": "Reply to an Outlook email by message ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string"},
                "body": {"type": "string", "description": "Reply text"},
            },
            "required": ["message_id", "body"],
        },
    },
]


# ── Dispatcher ─────────────────────────────────────────────────────────────────

def dispatch(tool_name: str, tool_input: dict, context: dict) -> str:
    """Execute a tool call from Claude. Returns string result."""
    chat_id = context.get("chat_id", 0)

    try:
        match tool_name:
            # System
            case "run_shell":
                result = system.run_shell(tool_input["command"], tool_input.get("timeout", 30))
            case "read_file":
                result = system.read_file(tool_input["path"])
            case "write_file":
                result = system.write_file(tool_input["path"], tool_input["content"])
            case "list_directory":
                result = system.list_directory(tool_input["path"])
            case "search_files":
                result = system.search_files(tool_input["pattern"], tool_input.get("directory", "~"))

            # Tasks
            case "create_task":
                result = tasks.create_task(tool_input["title"], tool_input.get("description", ""), tool_input.get("priority", "medium"), tool_input.get("due_date", ""))
            case "list_tasks":
                result = tasks.list_tasks(tool_input.get("status", "open"))
            case "complete_task":
                result = tasks.complete_task(tool_input["task_id"])
            case "update_task":
                result = tasks.update_task(tool_input["task_id"], tool_input.get("title", ""), tool_input.get("description", ""), tool_input.get("priority", ""), tool_input.get("due_date", ""), tool_input.get("status", ""))
            case "get_task":
                result = tasks.get_task(tool_input["task_id"])

            # Memory
            case "save_memory":
                result = memory.save_memory(tool_input["key"], tool_input["value"], tool_input.get("category", "general"))
            case "get_memory":
                result = memory.get_memory(tool_input["key"])
            case "search_memory":
                result = memory.search_memory(tool_input["query"])
            case "list_memory":
                result = memory.list_memory(tool_input.get("category", ""))

            # Research
            case "search_web":
                result = research.search_web(tool_input["query"], tool_input.get("max_results", 8))
            case "search_news":
                result = research.search_news(tool_input["topic"], tool_input.get("max_results", 8))
            case "fetch_url":
                result = research.fetch_url(tool_input["url"])

            # Docker
            case "docker_list":
                result = docker_tools.docker_list()
            case "docker_exec":
                result = docker_tools.docker_exec(tool_input["container_name"], tool_input["command"])
            case "docker_logs":
                result = docker_tools.docker_logs(tool_input["container_name"], tool_input.get("lines", 50))
            case "docker_start":
                result = docker_tools.docker_start(tool_input["container_name"])
            case "docker_stop":
                result = docker_tools.docker_stop(tool_input["container_name"])

            # Notifications & scheduling
            case "send_telegram":
                result = notifications.send_telegram(chat_id, tool_input["message"])
            case "schedule_message":
                result = scheduler.schedule_message(chat_id, tool_input["message"], tool_input["fire_at"])
            case "list_scheduled":
                result = scheduler.list_scheduled(chat_id)
            case "cancel_scheduled":
                result = scheduler.cancel_scheduled(tool_input["scheduled_id"])

            # Gmail
            case "gmail_list":
                result = google_tools.gmail_list(tool_input.get("query", ""), tool_input.get("max_results", 20))
            case "gmail_read":
                result = google_tools.gmail_read(tool_input["message_id"])
            case "gmail_send":
                result = google_tools.gmail_send(tool_input["to"], tool_input["subject"], tool_input["body"], tool_input.get("cc", ""))

            # Google Sheets
            case "sheets_read":
                result = google_tools.sheets_read(tool_input["spreadsheet_id"], tool_input.get("range_notation", ""))
            case "sheets_write":
                result = google_tools.sheets_write(tool_input["spreadsheet_id"], tool_input["range_notation"], tool_input["values"])
            case "sheets_list":
                result = google_tools.sheets_list(tool_input.get("query", ""))

            # Google Calendar
            case "calendar_list":
                result = google_tools.calendar_list(tool_input.get("days_ahead", 7), tool_input.get("max_results", 20))
            case "calendar_create":
                result = google_tools.calendar_create(tool_input["summary"], tool_input["start_datetime"], tool_input["end_datetime"], tool_input.get("description", ""), tool_input.get("location", ""), tool_input.get("attendees"))

            # Google Drive
            case "drive_list":
                result = google_tools.drive_list(tool_input.get("query", ""), tool_input.get("max_results", 20), tool_input.get("mime_filter", ""))
            case "drive_read":
                result = google_tools.drive_read(tool_input["file_id"])

            # Bank (Plaid)
            case "bank_accounts":
                result = finance_tools.bank_accounts()
            case "bank_transactions":
                result = finance_tools.bank_transactions(tool_input.get("days", 30), tool_input.get("account_id"), tool_input.get("category"))

            # QuickBooks
            case "qb_invoices":
                result = finance_tools.qb_invoices(tool_input.get("status"), tool_input.get("days", 90))
            case "qb_expenses":
                result = finance_tools.qb_expenses(tool_input.get("days", 30))
            case "qb_profit_loss":
                result = finance_tools.qb_profit_loss(tool_input.get("start_date"), tool_input.get("end_date"))
            case "qb_customers":
                result = finance_tools.qb_customers(tool_input.get("search"))

            # Outlook
            case "outlook_list":
                result = microsoft_tools.outlook_list(tool_input.get("folder", "inbox"), tool_input.get("max_results", 20), tool_input.get("filter_unread", False), tool_input.get("search"))
            case "outlook_read":
                result = microsoft_tools.outlook_read(tool_input["message_id"])
            case "outlook_send":
                result = microsoft_tools.outlook_send(tool_input["to"], tool_input["subject"], tool_input["body"], tool_input.get("cc", ""), tool_input.get("importance", "normal"))
            case "outlook_reply":
                result = microsoft_tools.outlook_reply(tool_input["message_id"], tool_input["body"])

            case _:
                result = {"error": f"Unknown tool: {tool_name}"}

    except Exception as e:
        result = {"error": f"Tool execution error: {e}"}

    return json.dumps(result)
