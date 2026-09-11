# Deploying opsdash

Read this once before the first deploy. Three of these steps do not happen
by themselves, and the system fails closed on each — which is the intended
behaviour, and confusing if you are not expecting it.

## 1. Create the services

The blueprint at `../opsdash-render.yaml` describes a web service and a
managed Postgres. On Render: **New → Blueprint**, point it at this
repository, and it reads that file.

`autoDeploy` is **off** on purpose. This app posts to a ledger; a deploy
should be a decision, not a consequence of a push.

## 2. Run the migrations

Nothing runs them automatically. From a machine with `psql` and the
database URL from the Render dashboard:

```bash
export DATABASE_URL='<the connection string Render shows>'
for m in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m"; done
```

Then prove the schema is what the contract says it is — 59 assertions, all
of which must pass:

```bash
npm run db:verify
```

## 3. Create the accounts

```bash
export DATABASE_URL='<the connection string>'
npx tsx scripts/provision-users.ts
```

This prints one password per account, **once**. Nothing stores it —
not the database, not a log, not a file. Lose the printout and the
account is reset rather than recovered, which is the correct property for
a password store and an inconvenient one exactly when you would want it
not to be.

Every account is created needing a password change, so each password
works exactly once: to set a real one.

To reset a single account later:

```bash
npx tsx scripts/provision-users.ts accounting
```

That also bumps the account's session epoch, which signs out every session
it currently has.

## 4. Load the IFTA rates

Empty until somebody loads them, and a jurisdiction with no rate has its
line withheld from the return.

```bash
npx tsx -e "…"   # or paste the matrix into the IFTA screen's rate panel
```

The rate panel on `/ifta` takes the published matrix pasted straight from
[iftach.org](https://www.iftach.org/taxmatrix4/). It refuses a paste whose
highest rate is under $0.50 per gallon, because that means the wrong
column was copied — the matrix prints US$/gallon beside CAN$/litre, and
that mistake has already happened once during this build.

## What fails closed, and why

**No `SESSION_SECRET` in production → sign-in returns 500.** Deliberate.
The alternative is a hardcoded fallback, which means every deployment of
this code shares one signing key and anyone who has read the source can
mint an admin session. Render generates the value; if you deploy
elsewhere, set it yourself to 32+ random characters.

**No migrations run → every page errors.** The app does not create its own
schema. A system that silently migrates a production database on boot is a
system that will one day silently migrate it wrong.

**No accounts → nobody can sign in, including you.** There is no default
administrator and no backdoor.

## After deploying

- Sign in as `admin`, change the password, and check `/` renders.
- Confirm `/api/health` returns 200 without a cookie, and that
  `/api/dashboard` returns **401** without one. If the second is 200, stop
  and do not hand the URL out.
- Upload one real document end to end before anyone relies on a figure.

## Backups

Render's managed Postgres takes daily backups on paid plans. The ledger is
append-only, so a restore loses recent work rather than corrupting old
work — but confirm the backup schedule in the dashboard rather than
assuming it.
