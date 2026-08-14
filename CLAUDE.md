# Axel — Personal AI Operating System

Two-repo mono-repo: FastAPI backend + Telegram bot, running on the Mac mini.

## Architecture

```
Github/
├── axel-backend/       FastAPI service (port 8000) — Claude agentic loop + 46 tools
│   ├── main.py         HTTP server, /chat /clear /status /health endpoints
│   ├── axel_engine.py  Anthropic SDK agentic loop
│   ├── tool_registry.py Tool definitions + dispatcher (TOOLS list + dispatch())
│   ├── config.py       All env vars (loaded via python-dotenv)
│   ├── db.py           SQLite schema (conversations, tasks, memory, scheduler)
│   ├── conversation.py Per-chat history (40-message window)
│   ├── axel.db         SQLite database (gitignored)
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
├── axel-telegram/      Telegram bot — proxies user↔backend
│   ├── main.py         python-telegram-bot v21 polling
│   └── config.py       Bot env vars
│
├── install_mac_services.sh   One-shot launchd installer for both services
└── CLAUDE.md           This file
```

Both services share the backend's virtualenv at `axel-backend/venv`.

## Running locally (dev)

```bash
# Backend
cd axel-backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env  # fill in ANTHROPIC_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
uvicorn main:app --reload --port 8000

# Bot (separate terminal)
cd axel-telegram
source ../axel-backend/venv/bin/activate
cp .env.example .env  # fill in TELEGRAM_TOKEN + BACKEND_URL=http://localhost:8000
python main.py
```

## Testing

Run through the venv explicitly — these tools are not on the system PATH:

```bash
cd axel-backend
./venv/bin/pytest tests/ -v
./venv/bin/pytest tests/ -v -k "test_name"   # run specific test
./venv/bin/ruff check . --exclude venv       # lint
./venv/bin/ruff check . --exclude venv --fix # autofix
./venv/bin/mypy . --ignore-missing-imports   # type check
```

## Adding a new tool

1. Implement the function in `tools/<module>.py` — return a string or dict
2. Add the tool definition to `TOOLS` list in `tool_registry.py`
3. Add the dispatch case in `dispatch()` in `tool_registry.py`
4. Add a test in `tests/test_tools.py`

## Mac mini services

```bash
bash install_mac_services.sh    # regenerate plists, restart both services
```

### Logs — read these, not the ones in ~/Library

The launchd plists declare `StandardOutPath` under `~/Library/Logs/Axel/`, but both
start scripts redirect stdout/stderr to the repo instead. **The `~/Library/Logs/Axel/`
files are always 0 bytes.** The real logs are:

```bash
tail -f axel-backend/logs/backend.log
tail -f axel-telegram/logs/bot.log
```

### Stop / start

```bash
launchctl unload ~/Library/LaunchAgents/com.axel.backend.plist
launchctl load   ~/Library/LaunchAgents/com.axel.backend.plist
launchctl list | grep axel        # check both are running
```

`KeepAlive` is true — the services restart on crash and start at login.

## Key env vars (axel-backend/.env)

| Var | Required | Purpose |
|-----|----------|---------|
| ANTHROPIC_API_KEY | yes | Claude API |
| TELEGRAM_TOKEN | yes | Bot auth + proactive send |
| TELEGRAM_CHAT_ID | yes | Sher's chat ID |
| BACKEND_API_KEY | yes | Secures /chat endpoint |
| CLAUDE_MODEL | no | `config.py` default is `claude-sonnet-5`; **`.env` currently pins `claude-sonnet-4-5`**, which wins |
| HOST | no | Default `0.0.0.0` — binds all interfaces. Set `127.0.0.1` to restrict to loopback |
| DB_PATH | no | Default `axel.db` |
| ALLOW_SHELL | no | Default: true |

`.env` is gitignored per-directory (`axel-backend/.gitignore`, `axel-telegram/.gitignore`),
along with `*.db`, `*.log`, `logs/`, `venv/`, and `__pycache__/`.

## Gotchas

- **Renaming a directory breaks the venv.** Console scripts (`pytest`, `pip`) hardcode an
  absolute shebang. After any rename, rewrite them:
  `grep -rl OLD_PATH venv/bin | xargs sed -i '' 's|OLD_PATH|NEW_PATH|g'`.
  `venv/bin/python` survives because it is a symlink.
- **`ALLOW_SHELL=true` plus `HOST=0.0.0.0` means anyone who can reach port 8000 and holds
  `BACKEND_API_KEY` can run shell commands as `sher`.** The bot connects over localhost, so
  nothing requires the external binding.
- **A masked API key fails as an encoding error, not an auth error.** A key pasted from a UI
  as `sk-ant-a••••` surfaces as `'ascii' codec can't encode characters in position 8-107`
  from `httpx/_models.py` — httpx ASCII-encodes header values. Check the key before
  chasing UTF-8.
- `start.sh` is an older manual start script; launchd uses `start_backend.sh`.

## Branch

Active development: `claude/repo-install-setup-qkrfre`
