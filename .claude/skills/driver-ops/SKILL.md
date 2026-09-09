# Driver Ops

Driver management, dispatch, load assignment, HOS, and communications.

## Triggers
- /driver-ops
- /driver-ops:dispatch
- /driver-ops:hos
- /driver-ops:onboard
- /driver-ops:communicate
- "dispatch driver"
- "driver status"
- "message driver"
- "HOS check"

## Driver Onboarding Checklist

Before assigning first load:

1. **CDL** — class A required for most freight; verify expiry > 6 months
2. **MVR** — motor vehicle record; no DUI in 7 years, < 3 moving violations in 3 years
3. **Background check** — criminal; no felonies involving vehicles/cargo
4. **Drug test** — DOT pre-employment 5-panel; must clear before driving
5. **Medical card** — DOT physical; expiry must be on file
6. **PSP report** — Pre-Employment Screening Program (FMCSA); check inspection + crash history
7. **Previous employer verification** — 3 years of employment history
8. **Add to TMS** — `create driver record with all expiry dates`

Document all above in TMS driver profile. Set reminders for expiry dates.

## HOS Rules (Property-Carrying Drivers)

| Rule | Limit |
|------|-------|
| 11-hour driving | 11 hrs driving after 10 consecutive hrs off |
| 14-hour window | Must complete driving within 14-hr window from start |
| 30-minute break | Required after 8 hrs on duty without break |
| 60/70-hour limit | 60 hrs in 7 days OR 70 hrs in 8 days |
| 34-hour restart | 34 consecutive hrs off resets the 60/70-hr clock |
| Sleeper berth | Split: 8+2 or 7+3 hrs (must include one period ≥ 7 hrs) |

**ELD mandate**: All carriers > 2 years old must use ELD. Ask for ELD provider name when booking.

## Dispatch Workflow

```
1. Load available → find available driver (check status + HOS hours remaining)
2. Offer load: origin, destination, pickup time, rate, equipment
3. Driver accepts → confirm in TMS → send rate con to carrier
4. Send pickup details: shipper name, address, contact, pickup #, commodity
5. Monitor: pickup confirmed? In transit? ETA?
6. Delivery: confirm POD received → update TMS status → trigger invoice
```

## Driver Communications

### WhatsApp (preferred for drivers)
Via Composio WHATSAPP_SEND_MESSAGE:
```
Dispatch: "Load available: Chicago IL → Dallas TX, pickup Tue 8am, 
           42k lbs dry van, $2,100. Interested?"
Driver accepts → send full load details
```

### Message Templates

**Load offer:**
```
Hi [Driver], load offer:
From: [Origin]
To: [Destination]  
Pickup: [Date/Time]
Delivery: [Date/Time]
Weight: [lbs] | Equipment: [type]
Rate: $[amount] all-in
Reply YES to accept or call [dispatcher #]
```

**Pickup reminder (night before):**
```
Reminder: Pickup tomorrow [Date] at [Time]
[Shipper Name] — [Address]
Contact: [Name] [Phone]
Pickup #: [#]
Commodity: [description]
Reply with any questions
```

**Delivery confirmation request:**
```
Hi [Driver], please confirm delivery of load [REF#] and send POD photo.
Thank you!
```

## Status Tracking

Driver statuses in TMS:
- `available` — ready for load offer
- `on_load` — assigned, in transit
- `off_duty` — HOS reset, not available
- `out_of_service` — mechanical issue, accident, etc.

Check driver availability before dispatch:
- `recall("driver [name] status")` for last known status
- Call TMS: `GET /drivers?status=available&location={city}`

## Compliance Reminders

Set automated Axel reminders for:
- CDL expiry: 60 days + 30 days + 7 days before
- Medical card expiry: same cadence
- Drug test: random pool selection (DOT requires ~50% of drivers annually)
- Annual MVR pull: every 12 months

Via Axel: `schedule_message("Run annual MVR for driver John Smith", "2026-01-15 09:00:00")`

## Common Issues

| Issue | Response |
|-------|----------|
| Driver calls with breakdown | Get location, call roadside assist, notify shipper of delay |
| Accident | Driver calls 911 first, then broker. Get incident #, notify shipper and carrier insurance |
| Driver goes off route | Call driver immediately — possible theft/hijacking if no answer |
| Late pickup | Proactively call shipper before they call you. Get new appointment |
| Refused at delivery | Get reason in writing. Call shipper. Document in TMS |
