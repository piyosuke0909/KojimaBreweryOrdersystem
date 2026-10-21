/** Install the pinned cloud toolchain without modifying the managed system Node. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = (await readFile(resolve(root, '.node-version'), 'utf8')).trim();
if (version !== '24.22.1') throw new Error('Update the reviewed release checksum when changing .node-version.');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This cloud installer supports Linux x64. Use nvm install / nvm use on other platforms.');
const filename = `node-v${version}-linux-x64.tar.xz`;
const expectedSha = '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6';
const keysRevision = '481637f813e912c4aa3622d7964ab426c97b8e8d';
const cache = resolve(root, '.local/node-download');
const tools = resolve(root, '.local/tools');
const installed = resolve(tools, `node-v${version}-linux-x64`);
await mkdir(cache, { recursive: true });
await mkdir(tools, { recursive: true });

async function download(name, url) {
  const target = resolve(cache, name);
  if (existsSync(target)) return target;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !['nodejs.org', 'github.com', 'raw.githubusercontent.com'].includes(new URL(response.url).hostname)) throw new Error(`Official download failed: ${name} (HTTP ${response.status}).`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600, flag: 'wx' });
  return target;
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed; installation stopped.`);
}
async function treeDigest(directory) {
  const hash = createHash('sha256');
  async function visit(relative = '') {
    for (const name of (await readdir(resolve(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const full = resolve(directory, path), entry = await lstat(full);
      hash.update(`${path}\0${entry.mode & 0o777}\0`);
      if (entry.isDirectory()) { hash.update('directory\0'); await visit(path); }
      else if (entry.isSymbolicLink()) hash.update(`link\0${await readlink(full)}\0`);
      else if (entry.isFile()) { hash.update('file\0'); hash.update(await readFile(full)); hash.update('\0'); }
      else throw new Error('Unexpected file type in the Node installation.');
    }
  }
  await visit();
  return hash.digest('hex');
}

const [archive, signature, keyring] = await Promise.all([
  download(filename, `https://nodejs.org/dist/v${version}/${filename}`),
  download('SHASUMS256.txt.asc', `https://nodejs.org/dist/v${version}/SHASUMS256.txt.asc`),
  download(`pubring-${keysRevision}.kbx`, `https://raw.githubusercontent.com/nodejs/release-keys/${keysRevision}/gpg/pubring.kbx`),
]);
const gnupg = await mkdtemp(resolve(cache, 'verify-'));
const staging = await mkdtemp(resolve(tools, '.node-verify-'));
await chmod(gnupg, 0o700);
const manifest = resolve(gnupg, 'SHASUMS256.verified.txt');
try {
  run('gpg', ['--batch', '--homedir', gnupg, '--no-default-keyring', '--keyring', keyring, '--output', manifest, '--decrypt', signature]);
  const signedSha = (await readFile(manifest, 'utf8')).split('\n').find(line => line.endsWith(`  ${filename}`))?.split(/\s+/)[0];
  const actualSha = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (signedSha !== expectedSha || actualSha !== signedSha) throw new Error('Node archive checksum verification failed. No archive was extracted.');
  run('tar', ['--no-same-owner', '-xJf', archive, '-C', staging]);
  const unpacked = resolve(staging, `node-v${version}-linux-x64`);
  if (existsSync(installed)) {
    if (await treeDigest(installed) !== await treeDigest(unpacked)) throw new Error('Existing Node installation differs from the verified archive. Move it aside and rerun the installer.');
  } else await rename(unpacked, installed);
  const actual = spawnSync(resolve(installed, 'bin/node'), ['--version'], { encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== `v${version}`) throw new Error('Installed Node version verification failed.');
  console.log(`Verified Node.js v${version}. Activate it with: source scripts/use-node.sh`);
} finally {
  await rm(gnupg, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
}
