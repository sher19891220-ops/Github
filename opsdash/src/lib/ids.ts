/**
 * Path-parameter validation shared by every route that takes an id.
 *
 * Every id in this schema is a `uuid`. Handed something that is not one,
 * Postgres raises `invalid input syntax for type uuid`, which reaches the
 * route as an unhandled exception and leaves as a 500 — the status that
 * means "this server is broken", for a request that is simply malformed.
 *
 * Two reasons that matters beyond tidiness. A 500 tells a caller to retry
 * and tells an operator to go looking for a fault that is not there. And
 * an unhandled database error is the usual way a schema detail ends up in
 * a response body — the message names the type, and often the column.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** The message a route returns for a malformed id. Deliberately says
 *  nothing about the schema beyond the shape an id takes. */
export function badIdMessage(name: string): string {
  return `${name} must be a UUID.`;
}
