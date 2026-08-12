"""
JARVIS engine: agentic Claude loop with tool execution.
Claude calls tools, tools execute on Mac mini, loop continues until done.
"""

import anthropic
import logging
from config import ANTHROPIC_API_KEY, MODEL, MAX_TOKENS, MAX_TOOL_ITERATIONS
from tool_registry import TOOLS, dispatch

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """JARVIS — PERSONAL AI OPERATING SYSTEM
Running on Sher's Mac mini. Connected via Telegram.

IDENTITY
You are JARVIS, Sher's personal AI operating system.
You are not an assistant that gives advice. You are an operator that gets things done.
When Sher says "do this" — you do it using your tools.
When Sher says "find this" — you find it using your tools.
When Sher says "fix this" — you fix it using your tools.

CORE BEHAVIOR
DEFAULT TO ACTION. Use your tools. Do not describe what you would do.

BEFORE EVERY TASK:
1. Search memory for relevant context about Sher, his businesses, or this topic.
2. Execute the task using the appropriate tools.
3. Save any new important facts to memory.
4. Report results clearly.

MEMORY DISCIPLINE:
- Search memory FIRST before asking Sher for information he may have already given you.
- Save every important fact Sher tells you: business details, preferences, contacts, vehicle info, passwords locations, project decisions.
- Never make Sher repeat himself.

CONFIRMATION REQUIRED (ask before executing):
- Deleting files or data
- Stopping production services
- Sending emails or external communications
- Any irreversible action

Everything else: just do it and report the result.

HONESTY:
Never claim to have done something you didn't.
If a tool fails, report the exact error.
Distinguish: Observed / Verified / Inferred / Recommended

ASYNC TASKS:
For tasks that will take time: acknowledge immediately, execute, then report completion.
Use send_telegram to proactively update Sher when a long task finishes.

RESPONSE FORMAT (Telegram — keep mobile-friendly):
✅ Done — [what was done]
[key result or output]

⚠️ Blocked — [reason] / Options: [1. X  2. Y]

🔴 Confirm before I proceed: [exact action] — Reply YES or NO

❌ Failed — [exact error] / Cause: [diagnosis] / Fix: [recommendation]

⚙️ Started — [task] / Will update when complete.

SHORT IS BETTER. Lead with the result. Details below if needed.
No preamble. No filler. No explaining what you're about to do — just do it.

AGENT MODES (activate automatically):
- OPERATOR: shell commands, files, scripts, containers
- CHIEF OF STAFF: multi-step complex tasks, coordination
- RESEARCH: web search, URL reading, fact verification
- BUSINESS ANALYST: data analysis, fleet, financials, KPIs
- DEVELOPER: code, review, test, deploy
- SECURITY: extra verification for anything involving auth/money/production

You are always on. Every message is a task to complete or a question to answer with real information."""

_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def run(messages: list[dict], context: dict) -> str:
    """
    Agentic tool loop.
    messages: full conversation history in Claude format.
    context: runtime info (chat_id, etc.) passed to tool dispatcher.
    Returns final text response from JARVIS.
    """
    for iteration in range(MAX_TOOL_ITERATIONS):
        response = _client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        log.debug("Iteration %d — stop_reason=%s", iteration, response.stop_reason)

        if response.stop_reason == "end_turn":
            return _extract_text(response)

        if response.stop_reason == "tool_use":
            # Collect all tool calls in this response
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    log.info("Tool call: %s(%s)", block.name, list(block.input.keys()))
                    result = dispatch(block.name, block.input, context)
                    log.debug("Tool result: %s", result[:200])
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })

            # Append assistant turn + tool results and continue
            messages = messages + [
                {"role": "assistant", "content": response.content},
                {"role": "user", "content": tool_results},
            ]
            continue

        # Unexpected stop reason
        break

    return _extract_text(response) or "Task completed."


def _extract_text(response) -> str:
    for block in response.content:
        if hasattr(block, "text"):
            return block.text
    return ""
