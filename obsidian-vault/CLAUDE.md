# Vault operating instructions

This vault is the shared long-term memory between me and Claude Code.
Read this file first in every session.

## What this business is

A vertically integrated trucking group: carriers + an asset-holding company that
owns the equipment + an in-house brokerage + an in-house truck shop. Entities are
titled under different family members and partners. Plus a freight-media side
project (Founder Hub).

### Entities

| Entity | Function | Titled under |
|---|---|---|
| **Zone-OH LLC** | Carrier | Me |
| **Xtrack LLC** | Carrier | My wife |
| **AFG Transport Co** | Carrier | Marat |
| **Runstar LLC** | Carrier — newly started | Timur |
| **Sher Trucking LLC** | Carrier — original entity, held since 2014 (started as a driver) | Me |
| **Iron Lease LLC** | Asset holding — owns ALL trucks in the group, leases to the carriers | — |
| **Shaeffer Technologies LLC** | Freight brokerage | Timur |
| **Fleet Prime LLC** | Truck shop | Me |
| ~~Truck Max USA LLC~~ | Former shop entity — **dissolved**, replaced by Fleet Prime | — |

### Group structure — the thing spreadsheets cannot show

Iron Lease owns the equipment and leases it to the carriers.
Fleet Prime services that equipment.
Shaeffer Technologies brokers freight to the carriers.

So a single truck generates entries in **three or four different entities'
books**. No individual P&L is the truth. Whenever a question is about
profitability, ask "at which level?" — unit, entity, or group — and say which
one you answered.

Because entities sit under different names, treat every Iron Lease ↔ carrier,
Fleet Prime ↔ carrier, and Shaeffer ↔ carrier transaction as **related-party**.
Log them in `[[_Intercompany]]`. Never net them away silently.

### Open questions about the map

- `P&L for I-TEAM & FORWARD` (accounting@iteamtrucking.net) — not on the list
  above. Own entity, partner, or customer? **Unresolved.**
- `fleetzonellc@gmail.com` owns `Fuel Avrg Company Report` and `Cases 2026` —
  is Fleet Zone an entity, or just an ops mailbox? **Unresolved.**
- `Parts Pice & Quantity` is owned by the dissolved Truck Max account.
  Migration to Fleet Prime not confirmed. **Unresolved.**

## Where the real data lives

Source of truth is Google Sheets (via the Google Drive connector), NOT this vault.
This vault holds **conclusions, history, and narrative** — the layer Sheets can't hold.

Key sheets:
- `ZONE Profit & Loss 2024 and 2025 and 2026`, `Xtrack LLC Profit and Loss Weekly`,
  `AFG Profit and Loss Weekly`, `P&L for I-TEAM & FORWARD`, `P&L yearly`
- `Fixed costs and OO, LO costs`, `Fixed costs by company`
- `Truck and trailer expenses ZONE (2025)`, `Odometers of trucks`, `Parts Pice & Quantity`
- `Fuel Avrg Company Report`, `Drivers Pay list (Zone LLC)`, `Dispatch Sheet 2026`
- `Performance analysis of CD (Zone LLC)`, `RISK MANAGEMENT`, `Cases 2026`, `1099`,
  `Lumper fee list`, `Zone List`, `Iron lease` / `Iron lease Leased trucks`

## Rules for Claude

1. **Never edit a Google Sheet without asking.** Read freely; write only on request.
2. **Always write findings back into this vault.** An analysis that only exists in
   chat is lost. Put it in the right folder as a dated, linked note.
3. **Link, don't duplicate.** Reference `[[Truck-1042]]`, `[[Driver-Name]]`,
   `[[2026-W34]]` instead of restating facts.
4. **Cite the sheet and the date** you pulled a number from. Numbers age fast.
5. **Flag, don't fix.** If a number looks wrong, write it in the note as a
   question — do not silently correct upstream data.
6. **Personal notes (`70-Personal/`) are never published, summarized externally,
   or included in Founder Hub content.**
7. Founder Hub drafts: check `60-Founder-Hub/Covered-Topics.md` before drafting so
   we don't repeat a story we already ran.

## My operating thresholds

<!-- FILL THESE IN. This is the single highest-leverage section of the vault —
     it turns Claude from a generic assistant into someone who knows your business. -->

- Target cost per mile (company truck): ???
- Target cost per mile (owner-operator): ???
- Gross margin per truck that triggers a review: ???
- Weekly revenue-per-truck floor: ???
- Repair spend on a unit that triggers "cycle it out" conversation: ???
- Acceptable driver turnover per quarter: ???
