# Axel — Personal AI Operating System

Two-repo mono-repo: FastAPI backend + Telegram bot, running on Mac mini.

## Architecture

```
Github/
├── jarvis-backend/     FastAPI service (port 8000) — Claude agentic loop + 46 tools
│   ├── main.py         HTTP server, /chat /clear /status /health endpoints
│   ├── jarvis_engine.py Anthropic SDK agentic loop
│   ├── tool_registry.py Tool definitions + dispatcher (TOOLS list + dispatch())
│   ├── config.py       All env vars (loaded via python-dotenv)
│   ├── db.py           SQLite schema (conversations, tasks, memory, scheduler)
│   ├── conversation.py Per-chat history (40-message window)
│   └── tools/          One file per integration
│       ├── system.py       Shell, file I/O
│       ├── tasks.py        Task CRUD
│       ├── memory.py       Key-value memory store
│       ├── research.py     DuckDuckGo + URL fetch
│       ├── docker_tools.py Docker container management
│       ├── notifications.py Proactive Telegram messages
│       ├── scheduler.py    APScheduler — scheduled Telegram messages
│       ├── google_tools.py Gmail, Sheets, Calendar, Drive (OAuth2)
│       ├── finance_tools.py Plaid (bank) + QuickBooks
│       └── microsoft_tools.py Outlook via Graph API (MSAL)
│
├── jarvis-telegram/    Telegram bot — proxies user↔backend
│   ├── main.py         python-telegram-bot v21 polling
│   └── config.py       Bot env vars
│
├── install_mac_services.sh   One-shot launchd installer for both services
└── CLAUDE.md           This file
```

## Running locally (dev)

```bash
# Backend
cd jarvis-backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env  # fill in ANTHROPIC_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
uvicorn main:app --reload --port 8000

# Bot (separate terminal)
cd jarvis-telegram
source ../jarvis-backend/venv/bin/activate
cp .env.example .env  # fill in TELEGRAM_TOKEN + BACKEND_URL=http://localhost:8000
python main.py
```

## Testing

```bash
cd jarvis-backend
pytest tests/ -v
pytest tests/ -v -k "test_name"   # run specific test
ruff check .                        # lint
ruff format .                       # format
mypy . --ignore-missing-imports     # type check
```

## Adding a new tool

1. Implement the function in `tools/<module>.py` — return a string or dict
2. Add the tool definition to `TOOLS` list in `tool_registry.py`
3. Add the dispatch case in `dispatch()` in `tool_registry.py`
4. Add a test in `tests/test_tools.py`

## Mac mini services

```bash
bash install_mac_services.sh    # install/restart both launchd services

# Logs
tail -f ~/Library/Logs/Axel/backend.log
tail -f ~/Library/Logs/Axel/bot.log

# Stop/start
launchctl unload ~/Library/LaunchAgents/com.axel.backend.plist
launchctl load   ~/Library/LaunchAgents/com.axel.backend.plist
```

## Key env vars (jarvis-backend/.env)

| Var | Required | Purpose |
|-----|----------|---------|
| ANTHROPIC_API_KEY | yes | Claude API |
| TELEGRAM_TOKEN | yes | Bot auth + proactive send |
| TELEGRAM_CHAT_ID | yes | Sher's chat ID |
| BACKEND_API_KEY | yes | Secures /chat endpoint |
| CLAUDE_MODEL | no | Default: claude-sonnet-5 |
| ALLOW_SHELL | no | Default: true |

## Branch

Active development: `claude/repo-install-setup-qkrfre`
