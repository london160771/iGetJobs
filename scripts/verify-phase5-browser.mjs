/* global document, innerWidth, innerHeight, getComputedStyle */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { readServerEnv } from '../apps/api/dist/env.js';
import { normalizeLead } from '../apps/api/dist/discovery/normalize.js';
import { leadToRow } from '../apps/api/dist/discovery/repository.js';
import { auditLead } from '../apps/api/dist/audit/engine.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'),'utf8');
config({ path:'.env',quiet:true });
if (process.env.SUPABASE_SMOKE_EMAIL && process.env.SUPABASE_SMOKE_PASSWORD) {
  process.env.SUPABASE_TEST_EMAIL_A=process.env.SUPABASE_SMOKE_EMAIL;
  process.env.SUPABASE_TEST_PASSWORD_A=process.env.SUPABASE_SMOKE_PASSWORD;
}
const target = new URL(process.env.VERIFY_WEB_URL || 'http://127.0.0.1:5173/');
const loopback = ['127.0.0.1','localhost','[::1]'].includes(target.hostname);
if ((!loopback && !(target.protocol === 'https:' && /^igetjobs(?:-[a-z0-9-]+)?\.vercel\.app$/.test(target.hostname))) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Use the approved Vercel app or loopback origin.');
const settings = readServerEnv(process.env), client = createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false },global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } });
const ids = []; let browser,page,checkpoint = 'Setup', exceptions = 0;
function check(condition,label) { checkpoint = label; if (!condition) throw new Error(); console.log('PASS: ' + label); }
async function accessible(page,label) {
  await page.evaluate(axeSource); // DevTools evaluation does not weaken app CSP.
  const result = await page.evaluate(async () => globalThis.axe.run(document,{ runOnly:{ type:'tag',values:['wcag2a','wcag2aa','wcag21aa'] } }));
  for (const violation of result.violations) console.log('Accessibility: ' + violation.id + ' ' + JSON.stringify(violation.nodes.map(node => ({ target:node.target,summary:node.failureSummary }))));
  check(result.violations.length === 0,'WCAG automated checks: ' + label);
}
try {
  await mkdir('.local',{ recursive:true });
  const login = await client.auth.signInWithPassword({ email:process.env.SUPABASE_TEST_EMAIL_A,password:process.env.SUPABASE_TEST_PASSWORD_A }); check(!login.error,'Browser fixture authentication');
  const lead = normalizeLead({ businessName:'Disposable V1 responsive ' + randomUUID(),country:'GB',city:'London',niche:'Dentists',phone:'+442079460958',sourceId:randomUUID(),metadata:{} },'CSV').lead;
  Object.assign(lead,await auditLead(lead)); ids.push(lead.id); await writeFile('.local/phase5-ui-ids.json',JSON.stringify(ids));
  check(!(await client.from('leads').insert(leadToRow(lead,login.data.user.id))).error,'Only generated responsive fixture inserted');
  browser = await chromium.launch({ channel:'chrome',headless:true });
  const context = await browser.newContext({ viewport:{ width:1280,height:720 } }); page = await context.newPage(); page.setDefaultTimeout(loopback ? 45000 : 180000);
  page.on('pageerror',() => { exceptions++; });
  await page.goto(target.origin + '/leads'); await page.waitForURL(target.origin + '/login'); check(true,'Signed-out workspace redirects to login');
  await accessible(page,'Login');
  check(await page.getByRole('button',{ name:'Create an account',exact:true }).count() === 0,'Private V1 exposes no public signup control');
  await page.getByLabel('Email',{ exact:true }).fill(process.env.SUPABASE_TEST_EMAIL_A); await page.getByLabel('Password',{ exact:true }).fill(process.env.SUPABASE_TEST_PASSWORD_A);
  await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(url => url.pathname !== '/login');
  const routes = ['/', '/search','/leads','/leads/' + lead.id,'/outreach','/settings','/missing-page'];
  for (const [width,height] of [[1280,720],[768,1024],[390,844],[320,740],[844,320]]) {
    await page.setViewportSize({ width,height });
    for (const route of routes) {
      checkpoint = 'Loading ' + route + ' at ' + width + '×' + height;
      await page.goto(target.origin + route); await page.locator('main h1').waitFor();
      if (route === '/search') await page.getByRole('button',{ name:'Find leads',exact:true }).waitFor();
      if (route === '/leads') await page.getByText('matching lead',{ exact:false }).waitFor();
      if (route === '/leads/' + lead.id) await page.getByRole('button',{ name:'Generate draft',exact:true }).waitFor();
      if (route === '/outreach') await page.getByText('Drafts require review.',{ exact:false }).waitFor();
      const geometry = await page.evaluate(() => ({ overflow:document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,content:getComputedStyle(document.querySelector('.workspace-content')).overflowY,main:document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth }));
      check(!geometry.overflow && !geometry.main && geometry.content === 'auto','No clipped content/document overflow: ' + route + ' ' + width + '×' + height);
      await accessible(page,route + ' ' + width + '×' + height);
    }
    await page.screenshot({ path:'.local/phase5-' + width + 'x' + height + '.png' });
  }
  await page.setViewportSize({ width:390,height:844 }); await page.goto(target.origin + '/search'); await page.getByRole('button',{ name:'Find leads',exact:true }).waitFor();
  await page.getByRole('button',{ name:'Open navigation',exact:true }).click();
  await page.getByRole('button',{ name:'Close navigation',exact:true }).waitFor();
  const focusables = page.locator('.sidebar a[href],.sidebar button:not([disabled])');
  await focusables.first().focus(); await page.keyboard.press('Shift+Tab'); check(await focusables.last().evaluate(element => element === document.activeElement),'Drawer traps reverse keyboard navigation');
  await page.keyboard.press('Tab'); check(await focusables.first().evaluate(element => element === document.activeElement),'Drawer traps forward keyboard navigation');
  await accessible(page,'Open mobile drawer');
  await page.getByRole('link',{ name:'Settings',exact:true }).click(); await page.getByRole('heading',{ name:'Settings',exact:true }).waitFor();
  check(await page.locator('.sidebar').getAttribute('aria-hidden') === 'true','Navigation selection closes drawer');
  // Failure/loading UI fixtures are explicitly browser transport fixtures.
  await page.route('**/api/management/leads?*',route => route.fulfill({ status:503,contentType:'application/json',body:JSON.stringify({ error:'Changes could not be loaded. Please retry.' }) }));
  await page.goto(target.origin + '/leads'); await page.getByRole('alert').waitFor(); check((await page.getByRole('alert').innerText()).includes('Please retry'),'Supabase/API failure has safe retry feedback');
  await page.unroute('**/api/management/leads?*');
  await page.goto(target.origin + '/leads?city=NoMatch-' + randomUUID()); await page.getByRole('heading',{ name:'No leads match these filters',exact:true }).waitFor(); check(true,'Empty filter results have a clear recovery state');
  await page.getByRole('button',{ name:'Sign out',exact:true }).click(); await page.waitForURL(target.origin + '/login');
  check(exceptions === 0,'No uncaught browser exceptions across V1 screens');
} catch (error) {
  console.error('FAIL: ' + checkpoint + ' (' + error.name + '). No credentials emitted.');
  if (page && !new URL(page.url()).pathname.startsWith('/login')) await page.screenshot({ path:'.local/phase5-ui-failure.png' }).catch(() => {});
  process.exitCode = 1;
}
finally {
  if (browser) await browser.close();
  if (ids.length && (await client.from('leads').delete().in('id',ids)).error) { console.error('FAIL: Browser fixture cleanup'); process.exitCode = 1; }
  await client.auth.signOut({ scope:'local' }).catch(() => {});
}
