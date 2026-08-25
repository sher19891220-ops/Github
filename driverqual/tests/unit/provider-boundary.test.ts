import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The portability requirement is only real if it is enforced.
 *
 * A vendor name reaching the domain layer, the database layer, or the UI is how
 * "provider-neutral" quietly stops being true — so this walks the source and
 * fails if it happens, rather than trusting the arrangement to survive future
 * edits.
 */

const SRC = path.join(process.cwd(), 'src');

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : full.match(/\.tsx?$/) ? [full] : [];
  });
}

/** Vendor identifiers that must not appear outside the provider directory. */
const VENDOR_PATTERNS = [/openai/i, /anthropic/i, /api\.openai\.com/i, /gpt-[0-9]/i];

/** Layers that must remain ignorant of which vendor is configured. */
const SEALED_DIRECTORIES = ['domain', 'db', 'components', 'app'];

describe('provider boundary', () => {
  it.each(SEALED_DIRECTORIES)('no vendor name appears in src/%s', (dir) => {
    const offenders: string[] = [];

    for (const file of filesUnder(path.join(SRC, dir))) {
      const contents = fs.readFileSync(file, 'utf8');
      for (const pattern of VENDOR_PATTERNS) {
        // The settings screen names the key a user pastes, which is a label
        // rather than a dependency; everything else is a boundary violation.
        const isSettingsLabel =
          file.includes('Settings') || file.includes('settings') || file.includes('api/settings');
        if (pattern.test(contents) && !isSettingsLabel) {
          offenders.push(`${path.relative(SRC, file)} matches ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the engine cannot reach a provider at all', () => {
    const engine = fs.readFileSync(path.join(SRC, 'domain', 'engine.ts'), 'utf8');
    expect(engine).not.toMatch(/from '@\/server/);
    expect(engine).not.toMatch(/fetch\(/);
  });

  it('the provider contract exposes no way to make a decision', async () => {
    const contract = fs.readFileSync(
      path.join(SRC, 'server', 'provider', 'types.ts'),
      'utf8',
    );
    // Providers transcribe and interpret. Deciding is the engine's alone.
    expect(contract).toMatch(/extractDriverEvidence/);
    expect(contract).toMatch(/extractGuideline/);
    expect(contract).toMatch(/extractCertificateOfInsurance/);
    expect(contract).not.toMatch(/\bdecide\w*\(/);
    expect(contract).not.toMatch(/qualif\w*\(/);
  });

  it('swapping providers cannot change the stored schema', () => {
    // The schema is a plain string constant with no provider import; if a
    // vendor ever needed a column, this is where it would show up first.
    const schema = fs.readFileSync(path.join(SRC, 'db', 'schema.ts'), 'utf8');
    for (const pattern of VENDOR_PATTERNS) {
      expect(schema).not.toMatch(pattern);
    }
  });
});
