# Vault operating instructions

This vault is the shared long-term memory between me and Claude Code.
Read this file first in every session.

## What this business is

A multi-entity trucking / fleet operation plus a freight-media side project.

| Entity | Role |
|---|---|
| Zone LLC | Primary carrier (accounting, safety, HR each have own Google account) |
| Xtrack LLC | Carrier — weekly P&L tracked separately |
| AFG | Carrier — weekly P&L tracked separately |
| I-TEAM / Forward | Carrier — P&L shared from accounting@iteamtrucking.net |
| Iron Lease LLC | Truck leasing entity (leases units to the carriers) |
| TruckMax USA | Parts / maintenance |
| FleetZone | Fleet ops — fuel reports, claims/cases |
| Founder Hub | Content brand: B2B freight-marketing intel, published to Telegram |

> CORRECT THIS TABLE. It was inferred from Google Drive file ownership,
> not stated by me. Fix the roles and relationships before relying on it.

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
