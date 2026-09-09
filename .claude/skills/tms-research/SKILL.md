# TMS Research

Research agent skills for transportation, freight, and logistics intelligence.

## Triggers
- /tms-research
- /tms-research:rates
- /tms-research:carrier
- /tms-research:market
- /tms-research:compliance
- "check freight rates"
- "look up carrier"
- "research this lane"
- "FMCSA lookup"
- "what are rates on [lane]"

## Research capabilities

### /tms-research:rates — Freight Rate Research
Research current market rates for a lane.

Sources to check (via Firecrawl/Browser Use):
1. DAT RateView public benchmarks
2. Truckstop.com market rates
3. FreightWaves SONAR (public data)
4. Loadpay market intelligence

Output: Lane rate range (per mile), fuel surcharge, spot vs contract delta, trend (up/down/flat)

### /tms-research:carrier — Carrier Vetting
Look up a carrier before booking or onboarding.

Data to pull:
1. FMCSA SAFER system: MC#, DOT#, safety rating, insurance status, authority type
2. Carrier411 or similar: crash history, inspection record, OOS rate
3. Google: complaints, reviews, recent violations

URL: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string={DOT_NUMBER}`

Output: Safety rating, insurance ($1M+ cargo?), authority active?, red flags

### /tms-research:market — Market Intelligence
Research freight market conditions, capacity, and demand.

Topics: seasonal trends, lane-specific capacity, shipper activity by region, broker margins

### /tms-research:compliance — Regulatory Research
Look up FMCSA regulations, HOS rules, permit requirements.

Sources:
- FMCSA.dot.gov
- OOIDA regulatory updates
- State-specific permit rules (wide load, hazmat, etc.)

### /tms-research:fuel — Fuel Price Research
Current diesel prices by region for cost calculations.

Source: EIA weekly retail diesel report

## Integration with Axel

When Firecrawl and Browser Use are connected, Axel can run these researches automatically:
- "Axel, check rates on Chicago to Dallas reefer" → runs /tms-research:rates
- "Axel, vet carrier DOT 1234567" → runs /tms-research:carrier
- "Axel, what's diesel at in Texas?" → runs /tms-research:fuel
