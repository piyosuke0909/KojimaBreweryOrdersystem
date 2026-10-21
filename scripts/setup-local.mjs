import { appendFileSync, chmodSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, '.dev.vars');
mkdirSync(resolve(root, '.local'), { recursive: true });
if (!existsSync(file)) {
  writeFileSync(file, `SESSION_SECRET="${randomBytes(48).toString('base64url')}"\nADMIN_BOOTSTRAP_PASSWORD="${randomBytes(24).toString('base64url')}"\nINVITATION_TOKEN_ENCRYPTION_KEY="${randomBytes(32).toString('base64url')}"\n`, {mode: 0o600, flag: 'wx'});
  console.log('Created ignored .dev.vars with random local secrets. No credentials are logged.');
} else {
  const names=readFileSync(file,'utf8').split('\n').filter(x=>/^(SESSION_SECRET|ADMIN_BOOTSTRAP_PASSWORD)=/.test(x)).map(x=>x.split('=')[0]);
  console.log('Preserved existing .dev.vars. Required local bindings present:', names.join(', '));
  if (!names.includes('SESSION_SECRET')) throw new Error('Set SESSION_SECRET securely in .dev.vars before starting.');
  if (!/^INVITATION_TOKEN_ENCRYPTION_KEY=/m.test(readFileSync(file, 'utf8'))) {
    appendFileSync(file, `\nINVITATION_TOKEN_ENCRYPTION_KEY="${randomBytes(32).toString('base64url')}"\n`);
    chmodSync(file, 0o600);
    console.log('Added a private local invitation encryption key. Existing secrets were preserved.');
  }
}
