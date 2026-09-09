# AI Second Brain

Persistent knowledge management across all projects: business rules, contacts, decisions, project context, and lessons learned.

## Triggers
- /brain
- /brain:save
- /brain:find
- /brain:log
- "remember this"
- "what do we know about"
- "log this decision"
- "what did we decide about"
- "save for later"

## Storage backends

**Axel memory** (primary — persists across Telegram sessions):
- Use `save_memory(key, value)` for facts that Axel needs to recall
- Use `search_memory(query)` to retrieve

**CLAUDE.md** (project context — persists across Claude Code sessions):
- Add key facts/decisions to `## Project Memory` section in CLAUDE.md
- Read at session start automatically

**Axel DB tasks** (time-sensitive):
- Use `create_task` for items with deadlines

## Knowledge categories

### Business Rules
- Rate structures, lane preferences, carrier agreements
- Customer payment terms, credit limits
- Driver pay rates, bonus structures

### Technical Decisions
- Architecture choices and why (e.g., "chose Supabase over MongoDB because multi-tenant row-level security")
- API integrations, credentials location, service URLs
- Known bugs and workarounds

### Contacts & Relationships
- Shipper contacts: name, company, lane needs, last contact date
- Carrier/driver records: MC#, DOT#, equipment type, preferred lanes
- Vendor contacts: factoring company, insurance broker, maintenance shops

### Project Context
- Current TMS build status and next steps
- Axel bot open issues
- All bots running on Mac mini and their status

## Usage

**Save**: `/brain:save [category] — [fact]`
**Find**: `/brain:find [topic or question]`
**Log decision**: `/brain:log decision — [what we decided and why]`

## Output

Always confirm what was saved and where (Axel memory key, CLAUDE.md section, or task).
