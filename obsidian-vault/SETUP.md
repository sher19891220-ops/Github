# Obsidian + Claude Code — setup

The whole idea: **an Obsidian vault is just a folder of Markdown files, and
Claude Code is an agent that operates on a folder of files.** Point them at the
same folder and Obsidian becomes the interface to your notes while Claude
becomes the thing that writes, maintains, and queries them.

## 1. Install

- Obsidian: https://obsidian.md (free, desktop + mobile)
- Claude Code (desktop app or CLI): https://claude.com/claude-code

## 2. Create the vault

Copy the `obsidian-vault/` folder from this repo to somewhere permanent, e.g.
`~/Documents/Vault`. In Obsidian: **Open folder as vault** → pick it.

## 3. Put it in Git (this is the sync + backup + history layer)

```bash
cd ~/Documents/Vault
git init
git remote add origin git@github.com:<you>/vault-private.git   # PRIVATE repo
git add . && git commit -m "Initial vault"
git push -u origin main
```

Make the repo **private**. It will contain driver pay, claims, and financials.

## 4. Obsidian plugins — install these five, nothing more

| Plugin | Why |
|---|---|
| **Git** | Auto-commit + push every N minutes. This is what syncs desktop ↔ phone ↔ Claude. |
| **Templater** | Applies the files in `90-Templates/` |
| **Dataview** | Turns frontmatter into live tables ("all trucks in shop", "all open claims") |
| **Periodic Notes** | Weekly note per ISO week, matching `50-Weekly/` |
| **Tasks** | Rolls up every `- [ ]` across the vault into one view |

Skip everything else at the start. Over-plugining is the #1 reason vaults die.

## 5. Point Claude Code at it

```bash
cd ~/Documents/Vault
claude
```

Claude reads `CLAUDE.md` automatically on every session. That file is where your
business rules live — fill in the thresholds section, it is the highest-leverage
thing in the whole setup.

## 6. Mobile

Install Obsidian on your phone, clone the same repo (iOS: use Working Copy;
Android: the Git plugin works directly). Now `00-Inbox/` is capturable from the
road, and Claude files it at the weekly close.

## 7. First real workflow to run

Ask Claude, in the vault directory:

> Read `CLAUDE.md`. Pull this week's numbers from the Zone, Xtrack, AFG and
> I-TEAM P&L sheets via the Google Drive connector. Create
> `50-Weekly/2026-W34.md` from `90-Templates/weekly-close.md`, fill it in, cite
> which sheet and tab each number came from, and flag anything that crossed a
> threshold in `CLAUDE.md`.

Do that four weeks in a row and you have something no spreadsheet gives you:
a searchable, linked, narrated history of the business.
