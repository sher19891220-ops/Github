/**
 * The single import point every screen/component uses to talk to the API.
 *
 * Today this re-exports the local mock (`mockApi.ts`) because the API
 * agent's routes (`docs/DATA-CONTRACT.md` §6) are being built in parallel
 * and are not landed in this worktree yet. Once they are, swapping to the
 * real implementation is meant to be exactly this: change the import on
 * the next line to a `./httpApi` module that does the equivalent `fetch()`
 * calls against `/api/documents`, `/api/staging/:rowId`, etc. — no
 * component in `src/components/**` or `src/app/(screens)/**` should need
 * to change at all.
 */
export * from './mockApi';
