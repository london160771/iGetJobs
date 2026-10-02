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
  const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(90000) });
  check(health.status === 200, 'Production API health through Vercel proxy');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage(); page.setDefaultTimeout(180000);
  await page.goto(origin + '/login');
  await page.getByLabel('Email', { exact: true }).fill(process.env.SUPABASE_SMOKE_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(process.env.SUPABASE_SMOKE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(url => url.pathname !== '/login');
  await page.goto(origin + '/search');
  await page.getByLabel('Source').selectOption('GEOAPIFY');
  await page.getByLabel('Country').selectOption('GB'); await page.getByLabel('Niche').selectOption('dentists'); await page.getByLabel('City', { exact: true }).fill('Bath');
  const finding = page.waitForResponse(response => new URL(response.url()).pathname === '/api/discovery/search');
  checkpoint = 'Real production Bath/dentists GEOAPIFY Search';
  await page.getByRole('button', { name: 'Find leads', exact: true }).click();
  const found = await finding, preview = await found.json();
  // Store only safe status/timing/count evidence. Never dump auth/network headers.
  const after = await usage.load(), delta = (after.GEOAPIFY?.count || 0) - (before.GEOAPIFY?.period === after.GEOAPIFY?.period ? before.GEOAPIFY?.count || 0 : 0);
  await writeFile('.local/production-geoapify-result.json', JSON.stringify({ status: found.status(), rows: preview.rows?.length || 0, cached: preview.cached === true, quotaReservations: delta }));
  if (found.status() !== 200) {
    await page.getByRole('alert').waitFor(); await page.screenshot({ path: '.local/production-geoapify-mobile.png', fullPage: false });
    console.error('GEOAPIFY search HTTP status: ' + found.status() + '; durable reservations: ' + delta);
  }
  check(found.status() === 200 && preview.rows.length > 0, checkpoint);
  check(preview.cached ? delta === 0 : delta >= 1 && delta <= 12, 'Bounded production attempts charged durably');
  await page.getByRole('heading', { name: preview.rows.length + ' results to review', exact: true }).waitFor();
  for (const choice of await page.getByRole('combobox', { name: /Save choice for/ }).all()) await choice.selectOption('skip');
  const row = preview.rows.find(item => item.duplicate.kind === 'new') || preview.rows[0];
  await page.getByRole('combobox', { name: 'Save choice for ' + row.lead.businessName, exact: true }).selectOption(row.duplicate.kind === 'new' ? 'save' : 'separate');
  ids.push(row.lead.id); await writeFile('.local/production-geoapify-ids.json', JSON.stringify(ids));
  await page.getByRole('button', { name: 'Save selected (1)', exact: true }).click();
  await page.getByText('1 saved · 0 sources added.', { exact: false }).waitFor();
  check(true, 'One reviewed disposable GEOAPIFY lead saves through production UI');
  await page.screenshot({ path: '.local/production-geoapify-mobile.png', fullPage: false });
  await page.getByRole('link', { name: 'View saved leads →', exact: true }).click();
  await page.getByRole('link', { name: row.lead.businessName, exact: true }).waitFor(); await page.reload();
  await page.getByRole('link', { name: row.lead.businessName, exact: true }).waitFor();
  const persisted = await client.from('leads').select('source,source_id,provenance').eq('id', row.lead.id).single();
  check(!persisted.error && persisted.data.source === 'GEOAPIFY' && persisted.data.source_id === row.lead.sourceId && persisted.data.provenance.some(item => item.source === 'GEOAPIFY' && item.metadata.properties), 'Reload preserves normalized GEOAPIFY source and provider properties/coordinates');
  await page.getByRole('link', { name: row.lead.businessName, exact: true }).click();
  const auditChoice = page.getByLabel('Website to audit', { exact: true });
  if (await auditChoice.count()) {
    const candidates = await auditChoice.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
    check(candidates.length > 0, 'Preserved website candidates are available for explicit audit review');
    await auditChoice.selectOption(candidates[0]);
  }
  const auditing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/leads/' + row.lead.id + '/audit');
  checkpoint = 'Real saved Geoapify lead website audit';
  await page.getByRole('button', { name: 'Audit website', exact: true }).click();
  const audited = await auditing, assessment = (await audited.json()).lead;
  check(audited.status() === 200 && ['NO_WEBSITE','POOR_WEBSITE','ACCEPTABLE_WEBSITE'].includes(assessment?.classification), checkpoint);
  check(Number.isFinite(assessment.score) && assessment.score >= 0 && assessment.score <= 100 && assessment.scoreReasons.length > 0 && assessment.scoreReasons.reduce((sum, reason) => sum + reason.points, 0) === assessment.score, 'Geoapify lead has a persisted classification, bounded score and explicit score reasons');
  await page.getByText('Audit, classification, and score saved.', { exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Run audit again', exact: true }).waitFor();
  const savedAudit = await client.from('leads').select('classification,score,audit').eq('id', row.lead.id).single();
  check(!savedAudit.error && savedAudit.data.classification === assessment.classification && savedAudit.data.score === assessment.score && savedAudit.data.audit, 'Provider lead assessment survives reload');
  console.log('Measured provider lead classification: ' + assessment.classification + '; score: ' + assessment.score);
  await page.goto(origin + '/search'); await page.getByLabel('Source').selectOption('GEOAPIFY'); await page.getByLabel('Country').selectOption('GB');
  await page.getByLabel('Niche').selectOption('dentists'); await page.getByLabel('City', { exact: true }).fill('Bath');
  const repeating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/discovery/search');
  await page.getByRole('button', { name: 'Find leads', exact: true }).click();
  const repeated = await repeating, cached = await repeated.json();
  check(repeated.status() === 200 && cached.cached && cached.rows.length === preview.rows.length, 'Identical production GEOAPIFY search uses cache');
  check((await usage.load()).GEOAPIFY.count === after.GEOAPIFY.count, 'Cached production GEOAPIFY search consumes no quota');
  const duplicate = cached.rows.find(item => item.lead.sourceId === row.lead.sourceId);
  check(duplicate?.duplicate.kind !== 'new' && duplicate?.duplicate.matchIds.includes(row.lead.id), 'Repeated provider business is detected as a saved duplicate');
  const freshUsage = await supabaseUsageStore(process.env).load();
  check(freshUsage.GEOAPIFY.count === after.GEOAPIFY.count && freshUsage.GEOAPIFY.period === after.GEOAPIFY.period, 'Durable Geoapify quota survives discarded client/process state');
  await writeFile('.local/production-geoapify-result.json', JSON.stringify({ status: found.status(), rows: preview.rows.length, cached: preview.cached === true, quotaReservations: delta, repeatedCached: true, classification: assessment.classification, score: assessment.score, cleanupRequired: true }));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.waitForURL(origin + '/login');
} catch { console.error('FAIL: ' + checkpoint + '. No credentials emitted.'); process.exitCode = 1; }
finally {
  await browser?.close();
  if (ids.length) {
    const deleted = await client.from('leads').delete().in('id', ids);
    const remaining = await client.from('leads').select('id').in('id', ids);
    check(!deleted.error && !remaining.error && remaining.data.length === 0, 'Disposable GEOAPIFY verification lead removed');
  }
  await client.auth.signOut({ scope: 'local' }).catch(() => {});
}
