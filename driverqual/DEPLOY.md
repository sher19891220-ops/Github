# Deploying DriverQual

The application keeps its data in SQLite. That makes hosting simple on any
platform offering a **persistent disk**, and unsafe on any platform without one:
a serverless or free-tier filesystem resets between deploys, so every company,
applicant and evaluation you entered would disappear without an error.

Pick the section matching where you are deploying.

---

## Render (blueprint included)

`render.yaml` at the repository root describes the whole service. Render reads it
automatically.

1. Sign in at [render.com](https://render.com) and connect your GitHub account.
2. **New → Blueprint**, choose `sher19891220-ops/Github`, and select the branch
   holding this work (`claude/master-prompt-review-stdtjw`, or `main` once merged).
3. Render shows one service, `driverqual`, with a 1 GB disk mounted at
   `/var/data`. Approve it.
4. First build takes roughly 3–5 minutes. Your URL will be
   `https://driverqual.onrender.com` (Render appends a suffix if the name is taken).

### The plan requirement, stated plainly

The blueprint sets `plan: starter`, currently about **$7/month**. This is not an
upsell — Render does not offer persistent disks on the free tier, and without one
the database is erased on every restart. Deploying this blueprint on `free` would
appear to work and then lose data.

To stay free, use the hosted-database option below instead.

### After the first deploy

- **Settings → Environment** is where `OPENAI_API_KEY` and `FMCSA_API_KEY` go, if
  you want automatic document extraction and USDOT lookup. Both are optional; the
  app runs without them and says so rather than inventing data. You can also set
  them from the in-app Settings screen, which stores them in the database.
- The health check points at `/team`, a static screen, so a database problem
  surfaces as a visible error rather than a restart loop.

### Backups

A disk is not a backup. To copy the database down:

```bash
# From the Render shell (Dashboard → Shell)
sqlite3 /var/data/driverqual.db ".backup /var/data/backup.db"
```

Then download it from the shell, or add a scheduled job that pushes it to object
storage. For anything carrying real driver records, do this before you rely on it.

---

## Railway

Railway has volumes on its usage-based plan and no blueprint file is needed.

1. **New Project → Deploy from GitHub repo**, pick this repository.
2. **Settings → Root Directory**: `driverqual`.
3. **Settings → Volumes**: add one mounted at `/var/data`.
4. **Variables**: `DRIVERQUAL_DB=/var/data/driverqual.db`, `NODE_ENV=production`,
   and optionally `OPENAI_API_KEY` / `FMCSA_API_KEY`.
5. **Settings → Networking → Generate Domain** for a public URL.

Railway detects the build and start commands from `package.json`.

---

## Free hosting, or serverless

If you need a free deployment, or want Vercel, the filesystem cannot hold the
database and the storage layer has to move. The smallest change is
[Turso](https://turso.tech) (libSQL — SQLite's dialect and API), which keeps every
query in `src/db/repo.ts` as it is; only the connection in `src/db/index.ts`
changes, and the calls become asynchronous.

That is a contained but real change across the repository layer, so it is not
included here. Ask and I will do it.

---

## Anywhere else

The app is an ordinary Next.js server. It needs:

| Requirement | Detail |
| --- | --- |
| Node | 20 or newer (built and tested on 22) |
| Build | `npm ci && npm run build` |
| Start | `npm run start` — honours `PORT`, binds `0.0.0.0` |
| Writable path | for `DRIVERQUAL_DB`; the directory is created if absent |
| Native module | `better-sqlite3` compiles on install; most platforms use a prebuilt binary |

| Variable | Required | Purpose |
| --- | :-: | --- |
| `DRIVERQUAL_DB` | recommended | Database path (default `.data/driverqual.db`, relative to the working directory) |
| `OPENAI_API_KEY` | no | Document extraction |
| `OPENAI_MODEL` | no | Extraction model (default `gpt-4.1-mini`) |
| `FMCSA_API_KEY` | no | USDOT lookup |

---

## Before real driver records go in

This is a working application with a tested decision engine, but it has not been
through the hardening a system holding personal driving records deserves. Treat
these as prerequisites, not polish:

- **There is no authentication.** Anyone with the URL has full access. The role
  model in `src/app/team` documents intended permissions; it is not enforced yet.
  Put an authentication layer in front before the app is reachable publicly.
- **Uploaded files are not retained.** Documents are read and discarded; only the
  extracted evidence is stored. If your retention policy requires keeping the
  source documents, wire up private object storage.
- **Extraction and FMCSA lookup are written against the real APIs but have not
  been exercised with live keys.** Verify both against known documents before
  trusting them operationally.
- **Back up the database** on a schedule you have actually tested restoring from.
