# Humanizer

Rewrites AI-generated text to sound natural, warm, and human — not like a bot wrote it.

## Triggers
- /humanize
- "make this sound human"
- "rewrite this naturally"
- "this sounds robotic"
- "make it less AI"
- Used automatically when writing: driver emails, shipper outreach, customer messages, Telegram replies

## Rules

1. **Remove AI tells**: eliminate "certainly!", "absolutely!", "I'd be happy to", "As an AI", "Let me know if you need anything else", "Feel free to", bullet lists where prose works better, excessive hedging
2. **Match the register**: formal for legal/financial docs, casual for Telegram/SMS, professional-warm for driver/shipper emails
3. **Vary sentence length**: mix short punchy sentences with longer ones — AI always writes identical rhythm
4. **Use contractions**: "I'll", "we're", "it's", "don't" — real people use them
5. **Cut filler words**: "very", "really", "quite", "just", "actually", "basically", "essentially"
6. **Active voice**: "I'll send you the paperwork" not "The paperwork will be sent"
7. **Specific over generic**: "tomorrow at 2pm" not "soon", "call me at 312-555-1234" not "reach out"
8. **No walls of text**: break into natural paragraphs the way a person would pause speaking

## Output format

Rewritten text only — no explanation unless the user asks why you changed something.

## Context-specific rules

**Driver communications (TMS)**: Keep it short — drivers read on phones. Use trucking shorthand when appropriate (BOL, POD, load #). Direct, no fluff.

**Shipper outreach (TMS)**: Professional but not stiff. One ask per email. Specific rates/lanes, not "competitive pricing".

**Axel Telegram replies**: Sound like a capable assistant, not a customer service bot. First person, direct answers.

**Investor/business emails**: Confident, specific, no hedging. Numbers over adjectives.
