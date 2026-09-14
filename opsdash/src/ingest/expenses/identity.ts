export interface IssuedToSignals {
  raw: string;
  truckNumberCandidate: string | null;
  nameCandidate: string | null;
}

/**
 * `Issued To` mixes a driver name and a truck/unit number in unstable order
 * ("900101 NAME", "Name # 9002", "Name #900102"). This only splits out the
 * two raw signals for the review step. It never resolves them to a
 * canonical driver or truck — CLAUDE.md forbids resolving identity by
 * string match, and that resolution belongs to `source_key_map`, which this
 * parser has no access to and no business touching.
 */
export function extractIssuedToSignals(raw: string): IssuedToSignals {
  const trimmed = raw.trim();
  if (!trimmed) return { raw, truckNumberCandidate: null, nameCandidate: null };

  // "Name # 9002" / "Name #900102"
  const hashMatch = /^(.*?)\s*#\s*(\d+)\s*$/.exec(trimmed);
  if (hashMatch) {
    const namePart = (hashMatch[1] ?? '').trim();
    return { raw, truckNumberCandidate: hashMatch[2] as string, nameCandidate: namePart || null };
  }

  // "900101 NAME" — leading digit run followed by a name.
  const leadingMatch = /^(\d{3,})\s+(.+)$/.exec(trimmed);
  if (leadingMatch) {
    const namePart = (leadingMatch[2] ?? '').trim();
    return { raw, truckNumberCandidate: leadingMatch[1] as string, nameCandidate: namePart || null };
  }

  // "SomeName 9002" — trailing digit run, no separator.
  const trailingMatch = /^(.+?)\s+(\d{3,})$/.exec(trimmed);
  if (trailingMatch) {
    const namePart = (trailingMatch[1] ?? '').trim();
    return { raw, truckNumberCandidate: trailingMatch[2] as string, nameCandidate: namePart || null };
  }

  return { raw, truckNumberCandidate: null, nameCandidate: trimmed || null };
}
