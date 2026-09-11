/**
 * A small, framework-free state machine every live-data screen shares.
 *
 * The mock never exercised three states a real network has, and a screen
 * that conflates any pair of them misleads an accountant:
 *
 *  - `loading`   — the request has not resolved yet. Not a blank screen.
 *  - `error`     — the request failed. Says what failed, never a silent
 *                  empty table standing in for "we could not reach the
 *                  server".
 *  - `loaded`    — the request succeeded. `data` may legitimately be an
 *                  empty array ("nothing to review"), which must render
 *                  differently from `loading` and `error` even though a
 *                  careless component would show the same blank-ish thing
 *                  for all three.
 *
 * Kept as plain data + pure functions (no React) so it is unit-testable
 * under this repo's `node` vitest environment, which has no DOM.
 */

export type FetchState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: T };

export function loading<T>(): FetchState<T> {
  return { status: 'loading' };
}

export function loaded<T>(data: T): FetchState<T> {
  return { status: 'loaded', data };
}

export function errored<T>(message: string): FetchState<T> {
  return { status: 'error', message };
}

/**
 * True only for a successfully loaded, genuinely empty list. `false` for
 * `loading` and `error` — a blank-looking screen in either of those states
 * means something entirely different from "there is nothing to review",
 * and this function exists so that difference can't be lost by accident in
 * a component that just checks `data.length === 0`.
 */
export function isEmptyList<T>(state: FetchState<readonly T[]>): boolean {
  return state.status === 'loaded' && state.data.length === 0;
}

/** Extracts a human-readable message from whatever a failed request threw,
 *  falling back to a caller-supplied default rather than ever rendering
 *  `undefined` or `"[object Object]"` in an error banner. */
export function errorMessageFor(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
