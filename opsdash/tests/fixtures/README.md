# Fixtures

`real/` is **git-ignored**. Original vendor documents go here and never leave
this machine. This repository is public.

`redacted/` is committed. Each file mirrors a real document's structure and edge
cases with identifiers replaced, so the parser suite is reproducible for anyone
checking out the repo without exposing account or card numbers.

A redacted fixture must preserve what made the original interesting: the merged
header, the parenthesised negative, the footer total that is not a line item.
A cleaned-up fixture tests nothing worth testing.
