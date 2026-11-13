// One-time backend setup for username sign-in (tt-login) and background notifications (tt-push).
// Deploys both Edge Functions, sets their secrets, stores the Vault secrets, schedules the jobs in
// supabase/024_release_jobs.sql, checks the result, then writes the public push key into public/push-config.js.
//
//   SUPABASE_ACCESS_TOKEN=<token> node scripts/deploy-backend.mjs      (or run `npx supabase login` first)
//
// Optional: TT_ALLOWED_ORIGINS (comma-separated; default is the Vercel site), TT_VAPID_SUBJECT (mailto: or https: URL).
// Safe to re-run: it keeps an already published push key and rotates only the cron secret.
// Secrets are generated here and sent straight to Supabase; none are printed or left on disk.
import { spawnSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://turntactics.vercel.app';
const CLI = ['--yes', 'supabase@3.1.0']; // pinned: flag names differ between CLI major versions

const config = readFileSync(path.join(ROOT, 'public/online-config.js'), 'utf8');
const projectUrl = config.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[0], ref = projectUrl?.match(/\/\/([a-z0-9]+)\./)[1];
const publishable = config.match(/SUPABASE_PUBLISHABLE_KEY = '([^']+)'/)?.[1];
if (!ref || !publishable) fail('Could not read the project URL and publishable key from public/online-config.js.');

const pushConfigPath = path.join(ROOT, 'public/push-config.js');
const pushConfig = readFileSync(pushConfigPath, 'utf8');
const publishedKey = pushConfig.match(/VAPID_PUBLIC_KEY = '([^']*)'/)?.[1];
if (publishedKey === undefined) fail('public/push-config.js does not contain a VAPID_PUBLIC_KEY line.');

function fail(message) { console.error(`\nFAILED: ${message}`); process.exit(1); }
function supabase(args, { capture = false } = {}) {
  const run = spawnSync('npx', [...CLI, ...args, `--remote=${ref}`, '--yes'], { cwd: ROOT, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (run.status !== 0) fail(`supabase ${args.slice(0, 2).join(' ')} did not succeed.${capture ? '\n' + (run.stderr || run.stdout).trim() : ''}`);
  return run.stdout || '';
}
const step = (text) => console.log(`\n== ${text}`);
const quote = (text) => `'${text.replace(/'/g, "''")}'`;

const scratch = mkdtempSync(path.join(tmpdir(), 'tt-deploy-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

step(`Checking access to project ${ref}`);
supabase(['functions', 'list'], { capture: true });

step('Setting function secrets');
const cronSecret = randomBytes(32).toString('hex');
const secrets = {
  TT_ALLOWED_ORIGINS: process.env.TT_ALLOWED_ORIGINS || SITE,
  TT_PUBLISHABLE_KEY: publishable,
  TT_CRON_SECRET: cronSecret,
  TT_VAPID_SUBJECT: process.env.TT_VAPID_SUBJECT || SITE,
};
let publicKey = publishedKey;
if (!publicKey) {
  // A new pair is only safe while no key has been published: browsers subscribe against the public key.
  const pair = createECDH('prime256v1'); pair.generateKeys();
  const privateKey = Buffer.concat([Buffer.alloc(32), pair.getPrivateKey()]).subarray(-32); // left-pad to 32 bytes
  publicKey = pair.getPublicKey().toString('base64url');
  Object.assign(secrets, { TT_VAPID_PUBLIC_KEY: publicKey, TT_VAPID_PRIVATE_KEY: privateKey.toString('base64url') });
} else console.log('public/push-config.js already has a push key: keeping the existing key pair.');
const envFile = path.join(scratch, 'secrets.env');
writeFileSync(envFile, Object.entries(secrets).map(([name, value]) => `${name}=${value}\n`).join(''), { mode: 0o600 });
supabase(['secrets', 'set', '--env-file', envFile]);

step('Deploying tt-login and tt-push');
supabase(['functions', 'deploy', 'tt-login', 'tt-push', '--no-verify-jwt', '--use-api']);

step('Storing Vault secrets and scheduling jobs');
const vault = (name, value) => `do $$ declare v_id uuid; begin
  select id into v_id from vault.secrets where name = ${quote(name)};
  if v_id is null then perform vault.create_secret(${quote(value)}, ${quote(name)}); else perform vault.update_secret(v_id, ${quote(value)}); end if;
end $$;\n`;
const vaultFile = path.join(scratch, 'vault.sql');
writeFileSync(vaultFile, vault('tt_project_url', projectUrl) + vault('tt_cron_secret', cronSecret), { mode: 0o600 });
supabase(['db', 'query', '--file', vaultFile], { capture: true });
supabase(['db', 'query', '--file', path.join(ROOT, 'supabase/024_release_jobs.sql')], { capture: true });

step('Verifying');
const origin = (process.env.TT_ALLOWED_ORIGINS || SITE).split(',')[0].trim();
const problems = [];
const check = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` (${detail})`}`); if (!ok) problems.push(label); };
const fn = (name, init) => fetch(`${projectUrl}/functions/v1/${name}`, init);

const preflight = await fn('tt-login', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
check('tt-login accepts the site origin', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === origin, `HTTP ${preflight.status}`);
const wrong = await fn('tt-login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', apikey: publishable },
  body: JSON.stringify({ identifier: 'deploy_check_user', password: randomBytes(12).toString('hex') }) });
check('tt-login refuses unknown details with the generic answer', wrong.status === 401, `HTTP ${wrong.status}`);
const sender = await fn('tt-push', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tt-cron-secret': cronSecret }, body: '{}' });
const sent = await sender.json().catch(() => ({}));
check('tt-push runs with the cron secret', sender.status === 200 && typeof sent.claimed === 'number', `HTTP ${sender.status} ${sent.error || ''}`);
const unsigned = await fn('tt-push', { method: 'POST', body: '{}' });
check('tt-push refuses callers without the secret', unsigned.status === 401, `HTTP ${unsigned.status}`);
const jobs = supabase(['db', 'query', "select jobname from cron.job where active and jobname like 'turn-tactics-%' order by jobname"], { capture: true });
const expected = ['turn-tactics-chat-purge', 'turn-tactics-clock-log-cleanup', 'turn-tactics-pacific-clock', 'turn-tactics-push'];
check('four scheduled jobs are active', expected.every((name) => jobs.includes(name)), `missing ${expected.filter((name) => !jobs.includes(name)).join(', ')}`);

if (problems.length) fail(`${problems.length} check(s) did not pass. public/push-config.js was left unchanged; fix the cause and re-run.`);

if (!publishedKey) {
  writeFileSync(pushConfigPath, pushConfig.replace("VAPID_PUBLIC_KEY = ''", `VAPID_PUBLIC_KEY = '${publicKey}'`));
  console.log('\nDone. Commit public/push-config.js and deploy the site: notifications stay "pending setup" until that file is live.');
} else console.log('\nDone. Nothing to commit.');
