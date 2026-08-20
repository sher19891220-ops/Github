# Deploying DriverQual

Data lives in [Turso](https://turso.tech), a hosted libSQL database. libSQL is
SQLite's dialect and wire protocol, so the same queries run locally against a
file and in production against the hosted database — one code path, not two.

This means the app stores nothing on the server's filesystem, so it runs on free
tiers that reset the disk between deploys. Total cost of the setup below: **$0**.

---

## 1. Create the database (about 3 minutes)

1. Sign up at [turso.tech](https://turso.tech) — GitHub sign-in works.
2. Create a database. Any name; pick the region nearest your users.
3. From the database page, copy two values:
   - the **database URL**, which looks like `libsql://driverqual-yourname.turso.io`
   - a **auth token**, which you generate on that page

Keep both to hand for step 2. The token is a credential — treat it like a
password and do not commit it.

Prefer the CLI? `turso db create driverqual`, then `turso db show driverqual --url`
and `turso db tokens create driverqual`.

The schema creates itself on first boot — every statement is `IF NOT EXISTS`, so
there is no migration step and no seed data.

---

## 2. Deploy to Render (about 5 minutes)

`render.yaml` at the repository root describes the service; Render reads it
automatically.

1. Sign in at [render.com](https://render.com) and connect GitHub.
2. **New → Blueprint**, choose `sher19891220-ops/Github`, and select the branch
   holding this work (`claude/master-prompt-review-stdtjw`, or `main` once merged).
3. Render shows one free service, `driverqual`, and prompts for the environment
   variables marked `sync: false`. Fill in:
   - `TURSO_DATABASE_URL` — the `libsql://…` URL from step 1
   - `TURSO_AUTH_TOKEN` — the token from step 1
   - `OPENAI_API_KEY` and `FMCSA_API_KEY` — optional; leave blank for now
4. Approve. The first build takes roughly 3–5 minutes.

Your URL will be `https://driverqual.onrender.com`, with a suffix if that name is
taken.

### What free tier costs you

Render's free web services **sleep after about 15 minutes of inactivity**, so the
first request after a quiet spell takes 30–60 seconds while the container wakes.
Every request after that is normal speed. Nothing is lost while it sleeps — the
data is in Turso, not on the container.

If that wait is annoying in daily use, Render's Starter plan (~$7/month) keeps it
awake. The database stays free either way.

---

## 3. Optional integrations

Neither is required; the app runs without them and says so rather than inventing
data.

- **`OPENAI_API_KEY`** enables reading MVRs, CDLs and medical cards automatically.
  Without it, the drawer reports that extraction is unconfigured and you enter
  the evidence by hand.
- **`FMCSA_API_KEY`** enables USDOT lookup on the company form. Without it, the
  lookup reports that it is unconfigured and you type the details in.

Set either in the Render dashboard, or from the in-app Settings screen, which
stores them in the database. Stored keys are returned to the browser only as a
masked hint.

---

## Running locally

No Turso account needed — omit the environment variables and the app uses a local
file at `.data/driverqual.db` through the same libSQL client.

```bash
cd driverqual
npm install
npm run dev            # http://localhost:3000
```

To run locally against your hosted database instead:

```bash
TURSO_DATABASE_URL='libsql://…' TURSO_AUTH_TOKEN='…' npm run dev
```

---

## Other hosts

The app is an ordinary Next.js server with no filesystem state, so it also runs
on Vercel, Railway, Fly.io or any container host.

| Requirement | Detail |
| --- | --- |
| Node | 20 or newer (built and tested on 22) |
| Build | `npm ci && npm run build` |
| Start | `npm run start` — honours `PORT`, binds `0.0.0.0` |
| Storage | none on disk; all state is in libSQL |

| Variable | Required | Purpose |
| --- | :-: | --- |
| `TURSO_DATABASE_URL` | for hosting | `libsql://…`, or `file:…` for a local file (default `file:.data/driverqual.db`) |
| `TURSO_AUTH_TOKEN` | with a `libsql://` URL | Database credential |
| `OPENAI_API_KEY` | no | Document extraction |
| `OPENAI_MODEL` | no | Extraction model (default `gpt-4.1-mini`) |
| `FMCSA_API_KEY` | no | USDOT lookup |

---

## Backups

Turso's free plan keeps point-in-time restore for a limited retention window,
which covers accidents but is not an export you control. For a copy you hold:

```bash
turso db shell driverqual .dump > driverqual-backup.sql
```

Run it on a schedule you have actually tested restoring from before this holds
real driver records.

---

## Before real driver records go in

This is a working application with a tested decision engine, but it has not had
the hardening a system holding personal driving records deserves. Treat these as
prerequisites, not polish:

- **There is no authentication.** Anyone with the URL has full access. The role
  model on the Team & roles screen documents intended permissions; it is not
  enforced yet. Put authentication in front before the app is publicly reachable.
- **Uploaded files are not retained.** Documents are read and discarded; only the
  extracted evidence is stored. If your retention policy requires keeping source
  documents, wire up private object storage.
- **Extraction and FMCSA lookup are written against the real APIs but have not
  been exercised with live keys.** Verify both against documents whose correct
  answers you already know before trusting them operationally.
- **Keep the Turso auth token out of the repository.** It grants full read and
  write access to every driver record in the database.
