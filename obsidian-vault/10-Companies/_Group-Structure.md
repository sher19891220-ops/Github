---
type: group
---

# Group structure

```
                      ┌──────────────────┐
                      │  Iron Lease LLC  │  owns every truck
                      └────────┬─────────┘
                     leases equipment to
        ┌────────────┬─────────┼─────────┬────────────┐
        ▼            ▼         ▼         ▼            ▼
   Zone-OH LLC   Xtrack    AFG Transp  Runstar   Sher Trucking
      (me)       (wife)     (Marat)    (Timur)       (me)
        ▲            ▲         ▲         ▲            ▲
        └────────────┴────┬────┴─────────┴────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
┌───────────────────────┐        ┌────────────────────┐
│ Shaeffer Technologies │        │  Fleet Prime LLC   │
│  brokerage (Timur)    │        │   shop (me)        │
│  → sources freight    │        │   → services fleet  │
└───────────────────────┘        └────────────────────┘
```

## Why this matters for every financial question

A single truck touches three or four sets of books:

1. **Iron Lease** books lease revenue from the carrier
2. The **carrier** books that lease as an expense, plus fuel, driver pay, tolls
3. **Fleet Prime** books repair revenue from the carrier
4. **Shaeffer** books brokerage margin on loads it sources for the carrier

So "is Zone-OH profitable?" and "is that truck profitable?" and "did the group
make money?" are three different questions with three different answers.
Always state which one is being answered.

## Three levels of truth

| Level | Question it answers | Where the data is |
|---|---|---|
| **Unit** | Should we keep or cycle this truck? | `[[20-Fleet]]` notes + odometers + expenses |
| **Entity** | Is this LLC standing on its own? | Per-entity weekly P&L sheets |
| **Group** | Did we actually make money? | Nowhere yet — has to be built. See `[[_Intercompany]]` |

**The group level does not currently exist anywhere.** Building it is the single
highest-value thing this vault can do.

## Structural notes to work through
- Runstar is new — worth documenting why it was opened and what it is meant to do
  differently, while the reasoning is still fresh.
- Sher Trucking has been held since 2014. Oldest authority in the group; that
  operating history has real value. Decide deliberately whether it stays dormant
  or gets used.
- Ownership is spread across family and partners. Document what each person's
  economics actually are — this is exactly the knowledge that becomes disputed
  years later if it is never written down.
