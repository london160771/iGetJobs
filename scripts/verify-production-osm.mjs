import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { readServerEnv } from '../apps/api/dist/env.js';
import { supabaseUsageStore } from '../apps/api/dist/quota.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
config({ path: '.env', quiet: true });
const origin = 'https://igetjobs.vercel.app', ids = [];
const settings = readServerEnv(process.env), usage = supabaseUsageStore(process.env);
const client = createClient(settings.supabaseUrl, settings.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) }
});
let browser, page, checkpoint = 'Fresh smoke account authentication';
function check(value, label) { checkpoint = label; if (!value) throw new Error(); console.log('PASS: ' + label); }
try {
  await mkdir('.local', { recursive: true });
  const signed = await client.auth.signInWithPassword({ email: process.env.SUPABASE_SMOKE_EMAIL, password: process.env.SUPABASE_SMOKE_PASSWORD });
  check(!signed.error && signed.data.session, checkpoint);
  const before = await usage.load();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage(); page.setDefaultTimeout(180000);
  await page.goto(origin + '/login');
  await page.getByLabel('Email', { exact: true }).fill(process.env.SUPABASE_SMOKE_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(process.env.SUPABASE_SMOKE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(url => url.pathname !== '/login');
  await page.goto(origin + '/search');
  await page.getByLabel('Source').selectOption('OSM');
  await page.getByLabel('Country').selectOption('GB'); await page.getByLabel('Niche').selectOption('dentists'); await page.getByLabel('City', { exact: true }).fill('Bath');
  const finding = page.waitForResponse(response => new URL(response.url()).pathname === '/api/discovery/search');
  checkpoint = 'Real production Bath/dentists OSM Search';
  await page.getByRole('button', { name: 'Find leads', exact: true }).click();
  const found = await finding, preview = await found.json();
  // Store only safe status/timing/count evidence. Never dump auth/network headers.
  const after = await usage.load(), delta = (after.OSM?.count || 0) - (before.OSM?.period === after.OSM?.period ? before.OSM?.count || 0 : 0);
  await writeFile('.local/production-osm-result.json', JSON.stringify({ status: found.status(), rows: preview.rows?.length || 0, cached: preview.cached === true, quotaReservations: delta }));
  if (found.status() !== 200) {
    await page.getByRole('alert').waitFor(); await page.screenshot({ path: '.local/production-osm-mobile.png', fullPage: false });
    console.error('OSM search HTTP status: ' + found.status() + '; durable reservations: ' + delta);
  }
  check(found.status() === 200 && preview.rows.length > 0, checkpoint);
  check(preview.cached ? delta === 0 : delta >= 1 && delta <= 3, 'Bounded production attempts charged durably');
  await page.getByRole('heading', { name: preview.rows.length + ' results to review', exact: true }).waitFor();
  for (const choice of await page.getByRole('combobox', { name: /Save choice for/ }).all()) await choice.selectOption('skip');
  const row = preview.rows.find(item => item.duplicate.kind === 'new') || preview.rows[0];
  await page.getByRole('combobox', { name: 'Save choice for ' + row.lead.businessName, exact: true }).selectOption(row.duplicate.kind === 'new' ? 'save' : 'separate');
  ids.push(row.lead.id); await writeFile('.local/production-osm-ids.json', JSON.stringify(ids));
  await page.getByRole('button', { name: 'Save selected (1)', exact: true }).click();
  await page.getByText('1 saved · 0 sources added.', { exact: false }).waitFor();
  check(true, 'One reviewed disposable OSM lead saves through production UI');
  await page.screenshot({ path: '.local/production-osm-mobile.png', fullPage: false });
  await page.getByRole('link', { name: 'View saved leads →', exact: true }).click();
  await page.getByRole('link', { name: row.lead.businessName, exact: true }).waitFor(); await page.reload();
  await page.getByRole('link', { name: row.lead.businessName, exact: true }).waitFor();
  const persisted = await client.from('leads').select('source,source_id,provenance').eq('id', row.lead.id).single();
  check(!persisted.error && persisted.data.source === 'OSM' && persisted.data.source_id === row.lead.sourceId && persisted.data.provenance.some(item => item.source === 'OSM' && item.metadata.tags), 'Reload preserves normalized OSM source and raw tags');
  await page.goto(origin + '/search'); await page.getByLabel('Source').selectOption('OSM'); await page.getByLabel('Country').selectOption('GB');
  await page.getByLabel('Niche').selectOption('dentists'); await page.getByLabel('City', { exact: true }).fill('Bath');
  const repeating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/discovery/search');
  await page.getByRole('button', { name: 'Find leads', exact: true }).click();
  const repeated = await repeating, cached = await repeated.json();
  check(repeated.status() === 200 && cached.cached && cached.rows.length === preview.rows.length, 'Identical production OSM search uses cache');
  check((await usage.load()).OSM.count === after.OSM.count, 'Cached production OSM search consumes no quota');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.waitForURL(origin + '/login');
} catch { console.error('FAIL: ' + checkpoint + '. No credentials emitted.'); process.exitCode = 1; }
finally {
  await browser?.close();
  if (ids.length) {
    const deleted = await client.from('leads').delete().in('id', ids);
    const remaining = await client.from('leads').select('id').in('id', ids);
    check(!deleted.error && !remaining.error && remaining.data.length === 0, 'Disposable OSM verification lead removed');
  }
  await client.auth.signOut({ scope: 'local' }).catch(() => {});
}
