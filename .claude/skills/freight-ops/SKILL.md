# Freight Ops

Daily freight brokerage operations — load boards, carrier vetting, rate negotiation, documentation.

## Triggers
- /freight-ops
- /freight-ops:load-board
- /freight-ops:carrier-vet
- /freight-ops:rate-con
- /freight-ops:invoice
- "find a truck"
- "vet this carrier"
- "send rate con"
- "post a load"

## Load Board Workflow

### 1. Post a load
Use `extract_freight_rates` to benchmark the lane first, then post:
- **DAT**: dat.com — largest spot market
- **Truckstop**: truckstop.com
- **123Loadboard**: 123loadboard.com

Scrape with `scrape_page` or `fetch_url` if authenticated session exists.

### 2. Find available trucks on a lane
Search terms: `"{origin} {destination} {equipment} available truck"`
- Call `search_web` + `fetch_url` on load board results
- Filter by equipment type, pickup date window (±1 day), weight

### 3. Rate benchmark before negotiating
```
extract_freight_rates(origin, destination, equipment)
```
- All-in rate = linehaul + FSC (fuel surcharge)
- Target margin: 12–18% for spot, 8–12% for contract
- Never cover below $1.50/mile linehaul (van, short haul)

## Carrier Vetting Checklist

Before covering any load with a new carrier:

1. **FMCSA check** — `lookup_carrier_fmcsa(dot_number)` or MC#
   - Authority: ACTIVE (not pending, not revoked)
   - Safety rating: Satisfactory (not Conditional/Unsat)
   - OOS rate < 20% (national avg is ~5.5%)

2. **Insurance** — verify on FMCSA:
   - Cargo: $100K minimum (prefer $250K)
   - Liability: $1M minimum
   - Expiry date > load delivery date

3. **Carrier411** — `fetch_url("https://carrier411.com/carrier-report/{dot}")`
   - Check crash history, inspection violations
   - Red flag: > 2 crashes in 3 years

4. **Google search** — `search_web("{carrier name} DOT {dot} reviews complaints")`
   - Double-brokering complaints = immediate DO NOT USE
   - Recent cargo theft reports = immediate DO NOT USE

5. **Internal DO NOT USE list** — `recall("do not use carrier")` before calling

## Rate Confirmation

Rate con must include:
- Load reference #
- Origin / destination + pickup / delivery windows
- Commodity, weight, equipment
- Carrier name, MC#, DOT#
- Driver name + phone + truck/trailer #
- Total carrier pay (all-in)
- Payment terms (quick pay vs net 30)
- Broker name, MC#, contact info
- Detention rate (usually $50–75/hr after 2 hrs free)
- TONU (truck order not used) clause

Send via email; get signed before releasing pickup number.

## Documentation Flow

```
Load posted → Carrier found → Carrier vetted →
Rate con sent → Rate con signed → Pickup # released →
Pickup confirmed → In transit → Delivered →
POD (proof of delivery) received → Invoice sent → Paid
```

## Invoice Terms

- Standard: Net 30 from delivery
- Quick pay: 2–3% fee for same-week payment
- Factoring: sell invoice to factor at 2–4% discount for immediate cash
- Always attach: signed rate con + POD + delivery receipt

## Common Red Flags

| Red Flag | Action |
|----------|--------|
| Carrier calls on load within minutes of posting | Possible double-broker — verify they own the truck |
| Refuses to provide driver name/truck # | Do not cover |
| Asks to change destination mid-transit | Get written authorization, notify shipper |
| POD missing shipper signature | Chase before invoicing |
| Carrier calls asking for advance/cash advance | Proceed with caution, use Comcheck or EFS |

## Axel Integration

Axel can run the full vetting flow via Telegram:
- "Vet carrier DOT 1234567" → `lookup_carrier_fmcsa` + `search_web` + `recall` check
- "What are rates Chicago to Dallas van?" → `extract_freight_rates`
- "Remember: do not use ABC Trucking DOT 9876543 — double brokered load 2025-08" → `remember_this(importance=5)`
