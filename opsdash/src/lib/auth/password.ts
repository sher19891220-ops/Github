/**
 * Password hashing.
 *
 * scrypt, from Node's standard library. Chosen over bcrypt/argon2 not
 * because it is better but because it needs no native module: a native
 * dependency that fails to build is a deploy that fails at the worst
 * moment, and the marginal difference between well-parameterised scrypt
 * and argon2 is far smaller than the difference between having password
 * hashing and not.
 *
 * Three properties this file exists to guarantee:
 *
 *  - **A per-password salt**, so two people choosing the same password get
 *    different hashes and a stolen table cannot be attacked once for
 *    everyone.
 *  - **The parameters travel with the hash.** `scrypt$N$r$p$salt$hash`.
 *    Cost has to rise over the years, and a hash that cannot say how it
 *    was made can never be upgraded — every stored hash would have to be
 *    thrown away, which in practice means it never happens.
 *  - **Constant-time comparison.** `===` on a digest leaks, through timing,
 *    how many leading bytes were right, and that is enough to recover a
 *    hash byte by byte.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** `promisify` collapses scrypt's overloads and loses the options
 *  argument, so the callback form is wrapped by hand — the options are the
 *  entire point of using scrypt deliberately rather than at its defaults. */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

/** Current cost. N must be a power of two. 2^15 is roughly 100ms on a
 *  small server — slow enough to matter to an attacker, fast enough that
 *  a person signing in does not notice. */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** scrypt needs roughly 128*N*r bytes; Node's default cap is below that
 *  at this N, so it is raised explicitly rather than left to throw. */
const MAX_MEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, {
    N, r: R, p: P, maxmem: MAX_MEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row
 * must not become an exception that a caller might handle as "allow".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row rather than letting them
  // exhaust memory — a hash field is attacker-influenced if the database
  // is ever written to by anything but this code.
  if (n < 1024 || n > 1048576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: n, r, p, maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }

  // Lengths already match by construction; the guard keeps
  // timingSafeEqual from throwing if they ever do not.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when a stored hash was made with weaker parameters than current,
 *  so it can be transparently upgraded the next time the password is
 *  successfully used. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

/**
 * A generated initial password.
 *
 * Readable out loud and over a phone, because these get handed to people
 * that way whatever the policy says: no characters that look alike (no
 * O/0, l/1/I), grouped for transcription. ~10^18 possibilities, which is
 * far beyond guessing, and it is replaced on first sign-in anyway.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generatePassword(groups = 4, groupLen = 4): string {
  const bytes = randomBytes(groups * groupLen * 2);
  let out = '';
  let i = 0;
  for (let g = 0; g < groups; g += 1) {
    if (g > 0) out += '-';
    for (let c = 0; c < groupLen; c += 1) {
      // Rejection sampling: taking a raw byte modulo the alphabet length
      // biases the first few characters, which quietly shrinks the space.
      let b = bytes[i++]!;
      while (b >= 256 - (256 % ALPHABET.length)) b = randomBytes(1)[0]!;
      out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}
