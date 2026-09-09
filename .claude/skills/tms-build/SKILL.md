# TMS Build

Architecture, schema, and implementation guide for the freight brokerage TMS.

## Triggers
- /tms-build
- /tms-build:schema
- /tms-build:api
- /tms-build:frontend
- /tms-build:auth
- "build the TMS"
- "add to TMS"
- "TMS schema"

## Tech Stack

```
Supabase          Multi-tenant Postgres + Auth + Realtime + Storage
FastAPI           REST API layer (Python, mirrors Axel backend pattern)
React + Tailwind  Dispatcher dashboard (web)
React Native      Driver mobile app (future)
Composio          Social media, WhatsApp driver comms
Axel backend      AI brain — Claude loop with TMS tools
```

## Multi-tenant Design

Every table has `org_id UUID` FK → `organizations`. RLS enforces isolation.

```sql
-- Core tenancy
organizations (id, name, mc_number, dot_number, plan, created_at)
users (id, org_id, role TEXT, -- dispatcher | admin | driver | broker
       email, name, phone, created_at)
```

## Core Schema

```sql
-- Carriers
carriers (
  id, org_id, name,
  dot_number TEXT UNIQUE,
  mc_number TEXT,
  safety_rating TEXT,       -- Satisfactory | Conditional | Unsatisfactory
  insurance_expires DATE,
  authority_active BOOLEAN,
  oos_rate NUMERIC,
  status TEXT DEFAULT 'active', -- active | do_not_use | pending
  notes TEXT,
  created_at, updated_at
)

-- Drivers (for own fleet)
drivers (
  id, org_id, carrier_id,
  name, phone, email,
  license_number, license_state, license_expires DATE,
  status TEXT DEFAULT 'available', -- available | on_load | off_duty
  current_location TEXT,
  created_at, updated_at
)

-- Loads
loads (
  id, org_id,
  reference_number TEXT UNIQUE,
  status TEXT DEFAULT 'available',
    -- available | covered | in_transit | delivered | invoiced | paid | cancelled
  equipment TEXT DEFAULT 'van',    -- van | reefer | flatbed | step_deck
  weight NUMERIC,
  commodity TEXT,
  pickup_date DATE,
  delivery_date DATE,
  origin_city TEXT, origin_state TEXT, origin_zip TEXT,
  destination_city TEXT, destination_state TEXT, destination_zip TEXT,
  shipper_id UUID REFERENCES shippers,
  carrier_id UUID REFERENCES carriers,
  driver_id UUID REFERENCES drivers,
  rate NUMERIC,                     -- total rate charged to shipper
  carrier_pay NUMERIC,              -- what we pay carrier
  margin NUMERIC GENERATED ALWAYS AS (rate - carrier_pay) STORED,
  notes TEXT,
  created_at, updated_at
)

-- Shippers
shippers (
  id, org_id, name, contact_name, email, phone,
  credit_limit NUMERIC DEFAULT 0,
  payment_terms INTEGER DEFAULT 30, -- days
  status TEXT DEFAULT 'active',
  created_at, updated_at
)

-- Load events (tracking)
load_events (
  id, load_id,
  event_type TEXT, -- pickup_confirmed | in_transit | delivered | exception
  location TEXT,
  notes TEXT,
  created_at
)

-- Rate confirmations
rate_confirmations (
  id, load_id,
  document_url TEXT,
  sent_at DATETIME,
  signed_at DATETIME,
  created_at
)

-- Invoices
invoices (
  id, org_id, load_id, shipper_id,
  amount NUMERIC,
  due_date DATE,
  paid_at DATETIME,
  factored BOOLEAN DEFAULT false,
  created_at
)
```

## RLS Policies (Supabase)

```sql
-- All tables: users see only their org
CREATE POLICY "org_isolation" ON loads
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Drivers: see only assigned loads
CREATE POLICY "driver_own_loads" ON loads
  FOR SELECT USING (driver_id = auth.uid());
```

## FastAPI Structure

```
tms-backend/
├── main.py               FastAPI + lifespan + auth middleware
├── config.py             Supabase URL/key, env vars
├── routers/
│   ├── loads.py          CRUD + status transitions + search
│   ├── carriers.py       CRUD + FMCSA sync
│   ├── shippers.py       CRUD + credit check
│   ├── drivers.py        CRUD + availability
│   ├── invoices.py       Create + mark paid + factoring
│   └── tracking.py       Load event logging, ETA
├── services/
│   ├── fmcsa.py          FMCSA SAFER lookup (reuse axel research.py)
│   ├── rate_con.py       PDF generation for rate confirmations
│   ├── notifications.py  WhatsApp driver alerts via Composio
│   └── ai.py             Axel integration — rate suggestions, carrier vetting AI
└── models.py             Pydantic schemas
```

## Auth (Supabase Auth)

- Email+password for dispatchers/admins
- Magic link for drivers (no password to manage)
- JWT from Supabase passed as `Authorization: Bearer <token>` to FastAPI
- FastAPI verifies JWT against Supabase public key

```python
from supabase import create_client
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    user = supabase.auth.get_user(token)
    return user.user
```

## Agent Splits for Building (use /harness:workflow)

| Agent | Owns |
|-------|------|
| 1 — Schema | Supabase migrations, RLS policies, seed data |
| 2 — API | FastAPI routers: loads, carriers, shippers |
| 3 — API 2 | FastAPI routers: drivers, invoices, tracking |
| 4 — Dashboard | React dispatcher UI: load board, dispatch modal |
| 5 — Integrations | FMCSA sync, rate con PDF, WhatsApp alerts |
| 6 — Tests + CI | pytest for API, Playwright for UI smoke |

## Key Business Rules

- Margin must be > 0 before a load can be covered (enforced at API level)
- Carrier must have active authority + valid insurance before covering a load
- Rate confirmation must be signed before pickup is confirmed
- Invoices auto-generate on delivery
- Credit limit check on shipper before accepting new load

## Environment Variables

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=...     # server-side only, never expose to client
SUPABASE_ANON_KEY=...        # safe for client/browser
COMPOSIO_API_KEY=...         # for WhatsApp driver alerts
AXEL_URL=http://...          # Axel backend for AI features
AXEL_API_KEY=...
```
