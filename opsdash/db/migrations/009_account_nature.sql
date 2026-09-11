-- =====================================================================
-- Migration 009 — What kind of account a category is
--
-- `accounting.category` carries a group and a sign, and neither answers
-- the question the P&L engine actually has to ask: is this row an
-- expense, or is it money moving between an asset and a liability?
--
-- Two categories that already exist are not expenses at all:
--
--   prepaid.registration — the IRP/HVUT invoice is booked once, in full,
--     as a prepaid asset precisely so the real cost hits the P&L through
--     twelve monthly permit.irp / tax.hvut recognitions. Counting the
--     payment as well double-counts the year: the truck looks
--     catastrophically unprofitable for one day and free for the rest.
--
--   loan principal — only interest is a cost. Principal repayment is
--     debt going down, not money spent. Booking the whole payment
--     overstates cost by roughly $29.50 per truck per day on this fleet.
--
-- Lacking a column to say so, the rollup engine had been keying on the
-- category *name* — a regex for the word "principal". That works right
-- up until somebody names a genuine expense category with that word in
-- it, at which point a real cost silently disappears from every P&L at
-- every grain, and nothing anywhere says why. A guess applied to data is
-- the wrong shape for this; a fact recorded once, where the category is
-- defined, is the right one.
--
-- So the name rule does not disappear — it moves. It stops being a
-- filter applied to every row forever and becomes a CHECK applied once,
-- when a category is created. A category whose id names a balance-sheet
-- movement can no longer claim to be a P&L line at all.
-- =====================================================================

BEGIN;

CREATE TYPE accounting.account_nature AS ENUM (
  'pnl',            -- a recognized revenue or expense line
  'balance_sheet',  -- an asset/liability movement: a prepaid payment, a
                    -- loan principal repayment, a receivable
  'intercompany'    -- one leg of a balance between two entities in the
                    -- group; real on that entity's books, eliminated in
                    -- any group roll-up
);

-- Defaulting to 'pnl' reproduces exactly today's behaviour for every
-- category that already exists, rather than quietly reclassifying rows
-- nobody has looked at. The CHECK below is what stops that default from
-- becoming a way to sneak a balance-sheet movement onto the P&L.
ALTER TABLE accounting.category
  ADD COLUMN account_nature accounting.account_nature NOT NULL DEFAULT 'pnl';

-- The rows that are already wrong under the default, corrected here so
-- the flag is true the moment it exists rather than after a follow-up
-- nobody remembers to run.
UPDATE accounting.category
   SET account_nature = 'balance_sheet'
 WHERE category_id IN ('prepaid.registration', 'receivable.driver');

UPDATE accounting.category
   SET account_nature = 'intercompany'
 WHERE category_id IN ('receivable.intercompany', 'payable.intercompany');

-- The existing rows are corrected FIRST, because a CHECK added to a
-- table validates every row already in it. Adding the constraint before
-- the UPDATE aborts the migration on the very rows it exists to protect
-- — which is what happened on the first run of this file, and is the
-- gate working rather than a surprise.

-- The name rule, in the one place it belongs. A category id that names a
-- principal repayment, a prepaid asset, a receivable or a payable is not
-- a profit-and-loss line, and the database now refuses to record it as
-- one. This fires at definition time, when a person is right there to
-- correct it, instead of silently at every roll-up forever after.
ALTER TABLE accounting.category
  ADD CONSTRAINT balance_sheet_names_are_not_pnl CHECK (
    account_nature <> 'pnl'
    OR (
      category_id !~* '(^|[._-])principal([._-]|$)'
      AND category_id !~* '^(prepaid|receivable|payable)[._-]'
    )
  );

-- Revenue is a P&L line by definition. A revenue category declaring
-- itself a balance-sheet movement would drop real income out of every
-- total at once.
ALTER TABLE accounting.category
  ADD CONSTRAINT revenue_is_always_pnl CHECK (
    category_group <> 'revenue' OR account_nature = 'pnl'
  );

CREATE INDEX ix_category_nature ON accounting.category (account_nature);

COMMENT ON COLUMN accounting.category.account_nature IS
  'Whether this category is a P&L line, a balance-sheet movement, or an '
  'intercompany leg. The rollup engine reads this instead of guessing '
  'from the category name; balance-sheet rows are excluded at every '
  'grain and intercompany legs are eliminated in a group roll-up only.';

COMMIT;
