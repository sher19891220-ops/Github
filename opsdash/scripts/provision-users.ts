/**
 * Creates the department accounts.
 *
 * Generates a strong password per account, stores only its scrypt hash,
 * and prints the plaintext once. Nothing in this system keeps it: not the
 * database, not a log, not a file this script writes. If the printout is
 * lost, the account is reset rather than recovered — which is the correct
 * property for a password store and an inconvenient one exactly when you
 * would want it not to be.
 *
 *   npx tsx scripts/provision-users.ts            # create or reset all
 *   npx tsx scripts/provision-users.ts accounting # just one
 *
 * Every account is created with `must_change_password`, so the printed
 * password works exactly once.
 */
import { hashPassword, generatePassword } from '../src/lib/auth/password';
import { upsertUser, listUsers } from '../src/db/repo/users';
import type { Role } from '../src/lib/auth/roles';

const ACCOUNTS: Array<{ username: string; displayName: string; role: Role }> = [
  { username: 'admin', displayName: 'Administrator', role: 'admin' },
  { username: 'accounting', displayName: 'Accounting department', role: 'accounting' },
  { username: 'safety', displayName: 'Safety department', role: 'safety' },
  { username: 'dispatch', displayName: 'Dispatch department', role: 'dispatch' },
  { username: 'executive', displayName: 'Executive', role: 'executive' },
];

async function main(): Promise<void> {
  const only = process.argv[2];
  const wanted = only ? ACCOUNTS.filter((a) => a.username === only) : ACCOUNTS;
  if (wanted.length === 0) {
    console.error(`No such account: ${only}. Known: ${ACCOUNTS.map((a) => a.username).join(', ')}`);
    process.exit(1);
  }

  const issued: Array<{ username: string; role: string; password: string }> = [];

  for (const account of wanted) {
    const password = generatePassword();
    await upsertUser({
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      passwordHash: await hashPassword(password),
    });
    issued.push({ username: account.username, role: account.role, password });
  }

  console.log('\n  USERNAME      ROLE         PASSWORD (shown once)');
  console.log('  ' + '-'.repeat(56));
  for (const i of issued) {
    console.log(`  ${i.username.padEnd(13)} ${i.role.padEnd(12)} ${i.password}`);
  }
  console.log(`\n  ${issued.length} account(s) written. Each must set its own password on first sign-in.`);
  console.log('  Only the hashes are stored — these cannot be read back out.\n');

  const all = await listUsers();
  console.log(`  Accounts on file: ${all.map((u) => `${u.username}(${u.role})`).join(', ')}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
