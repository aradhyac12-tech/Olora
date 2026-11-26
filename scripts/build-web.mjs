// Dependency-free web build: copies ./web to ./dist and writes dist/config.js from env.
// API_BASE_URL (optional) is the default server address baked into the app; users can still change it in the UI.
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'web'), out = resolve(root, 'dist');
if (!existsSync(resolve(src, 'index.html'))) { console.error('web/index.html is missing'); process.exit(1); }
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });
// Default = the Render service name in render.yaml. If Render gave your service a different URL, set API_BASE_URL at build time.
const apiBase = (process.env.API_BASE_URL ?? 'https://olora-api.onrender.com').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$/.test(apiBase)) { console.error('API_BASE_URL must be an https origin with no path, e.g. https://olora-api.onrender.com'); process.exit(1); }
// Public client values only (Supabase URL + publishable key). Never put a service_role key here.
// Defaults are the olora project (public values); override with SUPABASE_URL / SUPABASE_ANON_KEY (set both empty to disable Google sign-in).
const supabaseUrl = (process.env.SUPABASE_URL ?? 'https://reazimolvvcatpirqqsk.supabase.co').trim();
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_gKW4JAYDrlUc-h7_nh4WOA_Xuuphptw').trim();
// Public origin+path where THIS web app is hosted; invitation links are built from it (e.g. https://olora.onrender.com/). Empty in native builds => links show as codes.
const publicUrl = (process.env.PUBLIC_APP_URL ?? '').trim();
if (publicUrl && !/^https:\/\/[^\s]+$/.test(publicUrl)) { console.error('PUBLIC_APP_URL must be an https URL'); process.exit(1); }
const appScheme = (process.env.APP_SCHEME ?? 'olora').trim();
if (supabaseAnonKey.includes('service_role')) { console.error('refusing to bundle a service_role key'); process.exit(1); }
writeFileSync(resolve(out, 'config.js'), `window.APP_CONFIG = ${JSON.stringify({ apiBase, supabaseUrl, supabaseAnonKey, appScheme, publicUrl })};\n`);
for (const f of ['index.html', 'app.js', 'styles.css', 'config.js']) {
  if (!existsSync(resolve(out, f)) || statSync(resolve(out, f)).size === 0) { console.error(`dist/${f} missing or empty`); process.exit(1); }
}
console.log(`web build ok -> dist/ (api ${apiBase})`);
