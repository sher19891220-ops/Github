# opsdash runs on Docker rather than Render's native Node runtime for one
# reason: accounting uploads photos and scans of fuel statements, and reading
# those needs `pdftoppm` (poppler) and `tesseract` on the box.
#
# Render's native runtime ships neither, and its build has no apt — the docs
# say to use Docker for any OS-level package. So the OCR tools are installed
# here, where they can actually be installed, instead of in a buildCommand
# that would fail at deploy time.
# https://render.com/docs/native-runtimes

# ---------- build ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# next.config.ts sets typescript.ignoreBuildErrors = false on purpose: a
# stray `any` in a route handler is how a float gets back into the money
# path, so the image fails to build rather than shipping one.
RUN npm run build

# ---------- run ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# poppler-utils gives pdftotext (text layer) and pdftoppm (renders a page to
# an image for OCR). tesseract-ocr reads that image. Without them a scanned
# upload fails with a named missing-tool error rather than silently returning
# empty text that would look exactly like a blank document — but it still
# fails, so they are not optional once accounting starts sending photos.
#
# tesseract-ocr-eng is the language data; the base package alone reads
# nothing. Pinning is deliberately left to the base image's apt snapshot:
# these are stable Debian tools and a hard pin here rots faster than it helps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

# Production dependencies only — the build is already done.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# `next.config.ts` is TypeScript, and `next start` will go and npm-install
# typescript AT BOOT if it cannot find it — a network call and a write into
# node_modules while the health check is already ticking, as a non-root user
# who cannot write there. Verified: without this the container tries
# "Installing TypeScript as it was not found while loading next.config.ts".
#
# Copied from the builder rather than installed, so it is the exact version
# the lockfile already resolved, with no second network round trip. The
# typescript package has no dependencies of its own.
COPY --from=builder --chown=node:node /app/node_modules/typescript ./node_modules/typescript

# `--chown=node:node` matters: the layers above run as root, and `next start`
# writes to .next/cache at runtime. Copying them root-owned and then dropping
# to USER node gives a container that boots and then fails the first time it
# tries to cache a render.
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts
# No `public/` copy: this project has none, and COPY on a missing path fails
# the build rather than being skipped. Add it back the day one appears.

# Render sets PORT; `next start` reads it. Declared for local runs.
ENV PORT=3000
EXPOSE 3000

# Not root. An OCR pass shells out to tesseract on uploaded bytes, and that
# is the one place in this app where a malicious file meets a subprocess.
USER node

CMD ["npm", "run", "start"]
