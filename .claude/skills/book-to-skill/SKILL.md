# Book to Skill

Convert documents, books, regulations, or SOPs into structured Claude Code skills or Axel knowledge.

## Triggers
- /book-to-skill
- "turn this into a skill"
- "convert this document to a skill"
- "make axel know about this"
- "add this to the knowledge base"

## What it converts

- FMCSA regulations → compliance checklist skill
- DOT requirements → driver qualification skill
- Business SOPs → operational procedure skill
- Customer contracts → contract terms knowledge
- Technical docs → developer reference skill
- Pricing guides → rate calculation skill

## Process

1. **Analyze** the source document: identify main topics, key rules, decision trees, lookup tables
2. **Structure** as one of:
   - **Reference skill**: looked up when needed ("what's the HOS rule for short-haul?")
   - **Checklist skill**: step-by-step procedure ("onboard a new driver")
   - **Decision skill**: if/then logic ("do we need a hazmat placard?")
   - **Calculator skill**: compute outputs from inputs ("estimate fuel cost for this lane")
3. **Write the SKILL.md** with:
   - Clear triggers (when Claude should use this skill)
   - Condensed, scannable content (tables > paragraphs for reference)
   - Source citation at bottom
4. **Suggest storage location**: `.claude/skills/<name>/SKILL.md` or Axel memory via `save_memory`

## Output

A complete SKILL.md file ready to save, plus the command to install it.

## Common conversions for this project

**FMCSA Hours of Service** → HOS rules skill for driver scheduling
**FMCSA Driver Qualification File** → DQ checklist for driver onboarding
**DOT drug testing rules** → testing schedule and threshold skill
**Factoring agreement terms** → cash flow and fee calculation skill
**Rate confirmation template** → load acceptance checklist
