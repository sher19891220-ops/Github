# React Dashboard

Dispatcher dashboard patterns using React + Tailwind + Supabase Realtime. For TMS and any ops-heavy web app.

## Triggers
- /react-dashboard
- /react-dashboard:layout
- /react-dashboard:table
- /react-dashboard:realtime
- /react-dashboard:modal
- "build the dashboard"
- "dispatcher UI"
- "load board table"

## Tech Stack

```
React 18 + TypeScript
Tailwind CSS 3
@tanstack/react-query   Server state, caching, real-time sync
@tanstack/react-table   Headless table with sorting, filtering, pagination
react-hook-form         Forms with zod validation
@supabase/supabase-js   Auth + Realtime subscriptions
react-hot-toast         Non-blocking notifications
date-fns                Date formatting
lucide-react            Icons
```

## Project Structure

```
src/
├── app/                    Pages (React Router v6)
│   ├── loads/              Load board, load detail, new load
│   ├── carriers/           Carrier list, vetting, detail
│   ├── drivers/            Driver list, dispatch, detail
│   └── reports/            P&L, lane analytics
├── components/
│   ├── ui/                 Button, Badge, Modal, Input (shadcn/ui)
│   ├── loads/              LoadTable, LoadCard, LoadStatusBadge
│   ├── carriers/           CarrierVetCard, CarrierStatusBadge
│   └── layout/             Sidebar, TopBar, PageHeader
├── hooks/
│   ├── useLoads.ts         React Query + Supabase loads queries
│   ├── useCarriers.ts
│   └── useRealtime.ts      Supabase realtime subscriptions
├── lib/
│   ├── supabase.ts         Client singleton
│   └── utils.ts            cn(), formatCurrency(), formatDate()
└── types/
    └── database.ts         Generated from Supabase (supabase gen types)
```

## Load Board Table Pattern

```tsx
// Sortable, filterable, real-time updating load table
const columns: ColumnDef<Load>[] = [
  { accessorKey: 'reference_number', header: 'Ref #' },
  { accessorKey: 'status', header: 'Status',
    cell: ({ row }) => <LoadStatusBadge status={row.original.status} /> },
  { id: 'lane', header: 'Lane',
    cell: ({ row }) => `${row.original.origin_city}, ${row.original.origin_state} → ${row.original.destination_city}, ${row.original.destination_state}` },
  { accessorKey: 'pickup_date', header: 'Pickup',
    cell: ({ row }) => format(new Date(row.original.pickup_date), 'MMM d') },
  { accessorKey: 'rate', header: 'Rate',
    cell: ({ row }) => formatCurrency(row.original.rate) },
  { id: 'margin', header: 'Margin',
    cell: ({ row }) => <span className={row.original.margin > 0 ? 'text-green-600' : 'text-red-600'}>
      {formatCurrency(row.original.margin)} ({((row.original.margin / row.original.rate) * 100).toFixed(1)}%)
    </span> },
]
```

## Status Badge Colors

```tsx
const STATUS_COLORS = {
  available:  'bg-blue-100 text-blue-800',
  covered:    'bg-yellow-100 text-yellow-800',
  in_transit: 'bg-purple-100 text-purple-800',
  delivered:  'bg-green-100 text-green-800',
  invoiced:   'bg-orange-100 text-orange-800',
  paid:       'bg-gray-100 text-gray-800',
  cancelled:  'bg-red-100 text-red-800',
}
```

## Realtime Hook

```typescript
// hooks/useRealtime.ts
export function useLoadsRealtime(orgId: string) {
  const queryClient = useQueryClient()
  useEffect(() => {
    const channel = supabase.channel('loads')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'loads',
        filter: `org_id=eq.${orgId}`
      }, () => {
        queryClient.invalidateQueries({ queryKey: ['loads'] })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [orgId, queryClient])
}
```

## Dispatch Modal

Dispatch = assign a driver and carrier to an available load.
- Show available drivers with HOS hours remaining
- Show vetted carriers for the equipment type
- Show rate benchmarks for the lane (call TMS API which calls `extract_freight_rates`)
- On submit: update load status to 'covered', send WhatsApp to driver via Composio

## Sidebar Nav

```
📦 Loads          /loads
🚛 Carriers       /carriers
👤 Drivers        /drivers
📋 Shippers       /shippers
📄 Invoices       /invoices
📊 Reports        /reports
⚙️  Settings       /settings
```

## TypeScript Types from Supabase

```bash
supabase gen types typescript --project-id <ref> > src/types/database.ts
```

Use `Database['public']['Tables']['loads']['Row']` for fully-typed table rows.

## Deployment

- **Vercel**: `vercel --prod` (user has Vercel connected via Composio)
- Set env vars in Vercel dashboard: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- Supabase edge functions handle webhooks independently

## Performance

- React Query with `staleTime: 30_000` for load board (refresh every 30s)
- Realtime for status changes only (don't poll)
- Virtual scrolling for load tables > 100 rows (`@tanstack/react-virtual`)
- Suspense + lazy loading for route-level code splitting
