-- =====================================================================
-- Migration 014 — Who is allowed in
--
-- Until now there was no authentication of any kind: no middleware, no
-- session, no check anywhere. Every route was open to anyone who could
-- reach the server. That is fine on a laptop and disqualifying for a
-- system holding a company's ledger, and it is the reason the deploy gate
-- stayed shut.
--
-- Three decisions worth stating, because each has a tempting wrong
-- version:
--
--   Only a hash is stored, never a password. `password_hash` holds a
--   scrypt digest with a per-user salt. Nobody — including whoever runs
--   this database — can read a user's password back out. The initial
--   passwords are generated once, handed over, and not retained anywhere
--   in this system.
--
--   `must_change_password` starts true. A password that arrived over
--   chat, email or a phone call has been seen by more people and systems
--   than the user thinks. It works exactly once, to set a real one.
--
--   `is_active` is checked on every request, not just at login. A signed
--   session cookie is valid until it expires; without a per-request
--   check, disabling an account does nothing until then. For someone who
--   has just left the company, "nothing until then" is the whole problem.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS accounting.app_user (
  user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  -- scrypt: "scrypt$N$r$p$<salt b64>$<derived b64>". The parameters live
  -- in the string so they can be raised later without invalidating
  -- existing hashes — a hash that cannot say how it was made is a hash
  -- that can never be upgraded.
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin','accounting','safety','dispatch','executive')),
  is_active      boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  -- Bumped to invalidate every existing session for this user at once:
  -- a password change, or an administrator revoking access.
  session_epoch  integer NOT NULL DEFAULT 1,

  CONSTRAINT username_is_lowercase CHECK (username = lower(username)),
  CONSTRAINT username_is_not_blank CHECK (btrim(username) <> ''),
  -- A plaintext password stored here by mistake would not look like this.
  CONSTRAINT password_is_hashed CHECK (password_hash LIKE 'scrypt$%')
);

COMMENT ON COLUMN accounting.app_user.session_epoch IS
  'Incremented to invalidate every outstanding session for this user. A signed cookie carries the epoch it was issued under; a mismatch signs the holder out immediately rather than at expiry.';

-- Every sign-in attempt, successful or not. Not an optional nicety: the
-- first question after any incident is "who logged in, from where, and
-- when did it start failing", and that is unanswerable after the fact.
CREATE TABLE IF NOT EXISTS accounting.auth_event (
  event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  username    text NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('success','bad_password','unknown_user','inactive','locked')),
  ip          text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS ix_auth_event_username_at ON accounting.auth_event (username, at DESC);
CREATE INDEX IF NOT EXISTS ix_auth_event_at ON accounting.auth_event (at DESC);

COMMIT;
