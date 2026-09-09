# Supabase

Supabase schema design, RLS policies, migrations, and real-time patterns. Used for TMS and all multi-user projects.

## Triggers
- /supabase
- /supabase:schema
- /supabase:rls
- /supabase:migration
- /supabase:realtime
- "design the schema"
- "add RLS"
- "Supabase migration"

## Project Setup

```bash
npm install -g supabase
supabase init          # creates supabase/ directory
supabase link --project-ref <project-ref>
supabase db pull       # pull existing schema
supabase db push       # push migrations
```

## Schema Design Principles

1. **Multi-tenant first**: every table has `org_id UUID NOT NULL REFERENCES organizations`
2. **UUID primary keys**: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
3. **Audit timestamps**: `created_at TIMESTAMPTZ DEFAULT now()`, `updated_at TIMESTAMPTZ DEFAULT now()`
4. **Soft deletes** where needed: `deleted_at TIMESTAMPTZ` (NULL = active)
5. **Enums as TEXT with CHECK constraints** (easier to extend than Postgres enums)
6. **Generated columns** for derived fields (e.g. margin = rate - carrier_pay)

## Migration File Pattern

```sql
-- supabase/migrations/20260101000000_create_loads.sql

-- Enable RLS
ALTER TABLE loads ENABLE ROW LEVEL SECURITY;

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loads_updated_at
  BEFORE UPDATE ON loads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

## RLS Patterns

### Org isolation (most tables)
```sql
CREATE POLICY "org_members_only" ON loads
  FOR ALL USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );
```

### Role-based access
```sql
-- Drivers see only their assigned loads
CREATE POLICY "driver_own_loads" ON loads
  FOR SELECT USING (
    driver_id = auth.uid()
    OR
    (SELECT role FROM users WHERE id = auth.uid()) IN ('dispatcher', 'admin')
  );

-- Only admins can delete
CREATE POLICY "admin_delete" ON loads
  FOR DELETE USING (
    (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
  );
```

### Service role bypass (for backend)
Use `SUPABASE_SERVICE_KEY` — bypasses all RLS. Never expose to client.

## Supabase Python Client (FastAPI)

```python
from supabase import create_client, Client

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Query with filter
loads = supabase.table("loads").select("*").eq("org_id", org_id).eq("status", "available").execute()

# Insert
new_load = supabase.table("loads").insert({
    "org_id": org_id, "reference_number": "BR-001", "status": "available"
}).execute()

# Update
supabase.table("loads").update({"status": "covered"}).eq("id", load_id).execute()

# Auth — verify JWT from client
user = supabase.auth.get_user(jwt_token)
```

## Realtime Subscriptions (React)

```typescript
// Watch load status changes in real-time (dispatcher dashboard)
const channel = supabase
  .channel('loads-realtime')
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'loads',
    filter: `org_id=eq.${orgId}`
  }, (payload) => {
    updateLoadInList(payload.new)
  })
  .subscribe()
```

## Storage (Documents)

```python
# Upload rate confirmation PDF
with open("rate_con.pdf", "rb") as f:
    supabase.storage.from_("rate-confirmations").upload(
        f"org_{org_id}/load_{load_id}/rate_con.pdf", f
    )

# Get signed URL (24hr expiry)
url = supabase.storage.from_("rate-confirmations").create_signed_url(
    f"org_{org_id}/load_{load_id}/rate_con.pdf", 86400
)
```

## Edge Functions (Supabase serverless)

Use for: webhooks from carriers, email parsing, cron jobs.

```typescript
// supabase/functions/load-webhook/index.ts
Deno.serve(async (req) => {
  const body = await req.json()
  // process webhook
  return new Response(JSON.stringify({ ok: true }))
})
```

Deploy: `supabase functions deploy load-webhook`

## Common Indexes

```sql
CREATE INDEX idx_loads_org_status ON loads(org_id, status);
CREATE INDEX idx_loads_pickup_date ON loads(pickup_date) WHERE status = 'available';
CREATE INDEX idx_carriers_dot ON carriers(dot_number);
CREATE INDEX idx_load_events_load ON load_events(load_id, created_at DESC);
```

## TMS Environment Variables

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_KEY=eyJ...  # server only
SUPABASE_ANON_KEY=eyJ...     # client-safe
```
