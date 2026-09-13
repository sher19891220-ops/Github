-- Trailer cost is a fixed cost, not any truck's variable cost.
--
-- Trailers are pooled across the carriers: of the trailers with enough cost
-- history in the real expenses sheet to tell, 47% were pulled by trucks from
-- more than one company, and one by all three. A trailer cost row names the
-- truck that happened to be pulling it that day, so following that number
-- charges a tyre to whichever driver drew that trailer that week — and the
-- same trailer's next repair lands on a different truck, in a different
-- company. Per-truck cost per mile built on that is noise.
--
-- So trailer upkeep gets its own category group and a single category. One
-- line, deliberately: splitting it across the maintenance categories would
-- invite something downstream to divide it by a truck, which is the exact
-- mistake this exists to prevent.

ALTER TABLE accounting.category DROP CONSTRAINT IF EXISTS category_category_group_check;
ALTER TABLE accounting.category
  ADD CONSTRAINT category_category_group_check
  CHECK (category_group IN (
    'revenue','fuel','toll','maintenance','permit','ifta',
    'insurance','driver_pay','lease','other_cost','trailer'));
