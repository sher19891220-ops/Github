/**
 * The operator's own documents, which are not in this repository and never
 * will be: they carry unit numbers, driver names, home addresses, licence
 * numbers and worse. The build contract requires the engines to be proven
 * against real historical data rather than synthetic data, so these tests
 * are the most valuable ones here — and they are exactly the ones a public
 * CI runner cannot have the inputs for.
 *
 * Before this file existed, the path to those documents was written into
 * twelve test files as an absolute path inside one developer's home
 * directory. Four of them read it at import time, so on any other machine
 * the suite did not skip — it crashed. "797 tests pass" was true on one
 * container and nowhere else, and nothing said so.
 *
 * Point OPSDASH_FIXTURES at the directory to run them. Without it, suites
 * that need real documents are skipped by name, so the report says what did
 * not run instead of quietly reporting green.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

export const REAL_FIXTURES_DIR = process.env.OPSDASH_FIXTURES ?? '';

export function realFixture(name: string): string {
  // An unset directory resolves to a path that cannot exist, rather than to
  // the repository root — a relative resolve would make `existsSync` answer
  // questions about the wrong file.
  return REAL_FIXTURES_DIR ? path.join(REAL_FIXTURES_DIR, name) : path.join('/nonexistent-real-fixtures', name);
}

export function haveRealFixtures(...names: string[]): boolean {
  return REAL_FIXTURES_DIR !== '' && names.every((n) => existsSync(realFixture(n)));
}

export function readRealFixture(name: string): string {
  return readFileSync(realFixture(name), 'utf8');
}

/**
 * Registers a suite that needs real operator documents.
 *
 * `body` runs ONLY when the files are present. That is the whole point:
 * `describe.skipIf` still executes the callback to collect tests, so a
 * `readFileSync` at the top of a skipped suite throws anyway. This does not
 * call the body at all.
 *
 * When they are absent the suite is still registered, named, and visibly
 * skipped — so the test report carries the gap rather than hiding it.
 */
export function describeReal(name: string, files: string[], body: () => void): void {
  if (haveRealFixtures(...files)) {
    describe(name, body);
    return;
  }
  describe.skip(`${name}  [needs real documents: ${files.join(', ')}]`, () => {
    it('not run — set OPSDASH_FIXTURES to the directory holding them', () => {});
  });
}
