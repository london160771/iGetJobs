/* global document, innerWidth, innerHeight, getComputedStyle */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { readServerEnv } from '../apps/api/dist/env.js';
import { normalizeLead } from '../apps/api/dist/discovery/normalize.js';
import { leadToRow } from '../apps/api/dist/discovery/repository.js';
import { auditLead } from '../apps/api/dist/audit/engine.js';
// Optional browser test runtime; no Playwright dependency is required by the app.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
config({ path:'.env',quiet:true });
if (process.env.SUPABASE_SMOKE_EMAIL && process.env.SUPABASE_SMOKE_PASSWORD) {
  process.env.SUPABASE_TEST_EMAIL_A=process.env.SUPABASE_SMOKE_EMAIL;
  process.env.SUPABASE_TEST_PASSWORD_A=process.env.SUPABASE_SMOKE_PASSWORD;
}
const appUrl = new URL(process.env.VERIFY_WEB_URL || 'http://127.0.0.1:5173/');
if ((!['127.0.0.1','localhost','[::1]'].includes(appUrl.hostname) && !(appUrl.protocol==='https:' && appUrl.hostname==='igetjobs.vercel.app')) || !['http:','https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.search || appUrl.hash || appUrl.pathname !== '/') throw new Error('Browser verification requires the approved production or loopback origin.');
const origin = appUrl.origin;
const settings = readServerEnv(process.env), ids = [];
const client = createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false },global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } });
let browser, page, checkpoint = 'Browser setup';
const check = (condition,label) => { checkpoint = label; if (!condition) throw new Error('Fixture assertion'); console.log('PASS: ' + label); };
try {
  const login = await client.auth.signInWithPassword({ email:process.env.SUPABASE_TEST_EMAIL_A,password:process.env.SUPABASE_TEST_PASSWORD_A }); if (login.error || !login.data.user) throw new Error();
  const lead = normalizeLead({ businessName:'Disposable UI Outreach ' + randomUUID(),country:'GB',city:'London',niche:'Dentists',phone:'+442079460958',sourceId:randomUUID(),metadata:{} },'CSV').lead;
  Object.assign(lead,await auditLead(lead)); lead.status = 'Qualified'; ids.push(lead.id); await mkdir('.local',{ recursive:true }); await writeFile('.local/phase4-ui-ids.json',JSON.stringify(ids));
  if ((await client.from('leads').insert(leadToRow(lead,login.data.user.id))).error) throw new Error();
  browser = await chromium.launch({ channel:'chrome',headless:true });
  const context = await browser.newContext({ viewport:{ width:1280,height:720 },permissions:['clipboard-read','clipboard-write'] });
  page = await context.newPage(); page.setDefaultTimeout(appUrl.hostname==='igetjobs.vercel.app' ? 180000 : 45000);
  page.on('pageerror', error => { console.log('Browser exception category: ' + error.name); });
  checkpoint = 'Browser authentication'; await page.goto(origin + '/login');
  await page.getByLabel('Email',{ exact:true }).fill(process.env.SUPABASE_TEST_EMAIL_A); await page.getByLabel('Password',{ exact:true }).fill(process.env.SUPABASE_TEST_PASSWORD_A); await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(origin + '/');
  checkpoint = 'Browser lead detail loading'; await page.goto(origin + '/leads/' + lead.id);
  checkpoint = 'Browser generate action'; await page.getByRole('button',{ name:'Generate draft',exact:true }).click();
  checkpoint = 'Browser generated editor loading';
  await page.getByLabel('Message',{ exact:true }).waitFor();
  check(await page.getByRole('button',{ name:'Copy reviewed draft',exact:true }).isDisabled(),'Generated browser draft cannot be copied before review');
  await page.getByLabel('Message',{ exact:true }).fill('Disposable user-edited and reviewed outreach.');
  await page.getByLabel('I reviewed the current evidence and this draft for manual outreach.').check();
  await page.getByRole('button',{ name:'Save draft / review',exact:true }).click();
  await page.getByText('User-edited draft',{ exact:false }).waitFor();
  await page.getByRole('button',{ name:'Copy reviewed draft',exact:true }).click(); await page.getByText('Reviewed draft copied. Nothing was sent.',{ exact:true }).waitFor();
  check((await page.evaluate(() => navigator.clipboard.readText())).includes('Disposable user-edited and reviewed outreach.'),'Browser copy contains saved approved user edits');
  await page.reload(); await page.getByLabel('Message',{ exact:true }).waitFor(); check((await page.getByLabel('Message',{ exact:true }).inputValue()) === 'Disposable user-edited and reviewed outreach.','Browser draft edits survive reload');
  check(await page.getByRole('button',{ name:'Regenerate draft',exact:true }).isDisabled(),'Regeneration requires explicit replacement of user edits');
  checkpoint = 'No-op save editor regression';
  const beforeNoOp = (await client.from('leads').select('updated_at,outreach_draft,activity').eq('id',lead.id).single()).data;
  const savedBody = await page.getByLabel('Message',{ exact:true }).inputValue();
  await page.getByLabel('Message',{ exact:true }).fill(savedBody + ' temporary change');
  await page.getByLabel('Message',{ exact:true }).fill(savedBody);
  check(await page.getByRole('button',{ name:'Copy reviewed draft',exact:true }).isDisabled(),'Dirty editor blocks copying until saved');
  const noOpResponse = page.waitForResponse(response => response.url().endsWith('/save') && response.request().method() === 'POST');
  await page.getByRole('button',{ name:'Save draft / review',exact:true }).click();
  const noOpSaved = await noOpResponse;
  check(noOpSaved.status() === 200,'Unchanged draft save succeeds');
  const noOpLead = (await noOpSaved.json()).lead;
  check(noOpLead.updatedAt === beforeNoOp.updated_at && noOpLead.activity.length === beforeNoOp.activity.length,'No-op preserves timestamp and activity without relying on remount');
  await page.getByRole('button',{ name:'Copy reviewed draft',exact:true }).waitFor({ state:'visible' });
  // Locator assertions retry until React applies the server acknowledgement.
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Copy reviewed draft')?.disabled);
  check(!(await page.getByRole('button',{ name:'Mark Contacted manually',exact:true }).isDisabled()),'No-op save clears dirty state for manual Contacted');
  check(await page.getByLabel('I reviewed the current evidence and this draft for manual outreach.').isChecked(),'No-op retains server approval');
  check((await page.getByLabel('Message',{ exact:true }).inputValue()) === savedBody,'No-op does not replace user text');
  await page.getByRole('button',{ name:'Copy reviewed draft',exact:true }).click();
  await page.getByText('Reviewed draft copied. Nothing was sent.',{ exact:true }).waitFor();
  check((await page.evaluate(() => navigator.clipboard.readText())).includes(savedBody),'Copy succeeds after no-op without discard or reload');
  check(await page.getByRole('button',{ name:'Regenerate draft',exact:true }).isDisabled(),'No-op keeps replacement confirmation for saved user edits');
  check(await page.getByRole('button',{ name:'Find email with Hunter',exact:true }).isDisabled(),'Hunter lookup stays disabled without an audited domain');
  await page.goto(origin + '/outreach'); const card = page.getByRole('article').filter({ hasText:lead.businessName }); await card.waitFor();
  check((await card.innerText()).includes('approved'),'Ready card displays saved approval and contact data'); await card.getByRole('button',{ name:'Mark Contacted',exact:true }).click();
  await page.getByRole('button',{ name:'Contacted',exact:true }).click(); await card.waitFor(); check((await card.innerText()).includes('Contacted'),'Browser manual Contacted moves lead into Contacted tab');
  for (const [width,height] of [[1280,720],[768,1024],[390,844],[320,740],[844,320]]) {
    await page.setViewportSize({ width,height }); await page.goto(origin + '/outreach?tab=Contacted'); await card.waitFor();
    const geometry = await page.evaluate(() => ({ horizontal:document.documentElement.scrollWidth > innerWidth,vertical:document.documentElement.scrollHeight > innerHeight,menu:getComputedStyle(document.querySelector('.menu-button')).display,workspace:getComputedStyle(document.querySelector('.workspace-content')).overflowY }));
    check(!geometry.horizontal && !geometry.vertical && geometry.workspace === 'auto','One workspace scroller without document overflow at ' + width + '×' + height);
    const mobile = width <= 760 || width <= 960 && height <= 500;
    if (mobile) {
      await page.getByRole('button',{ name:'Open navigation',exact:true }).click();
      await page.getByRole('button',{ name:'Close navigation',exact:true }).waitFor();
      check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Close navigation'),'Drawer takes keyboard focus at ' + width + '×' + height);
      check(await page.evaluate(() => document.querySelector('.workspace').inert && getComputedStyle(document.querySelector('.workspace-content')).overflowY === 'hidden'),'Drawer locks background at ' + width + '×' + height);
      await page.keyboard.press('Escape'); check(await page.getByRole('button',{ name:'Open navigation',exact:true }).evaluate(element => element === document.activeElement),'Escape restores menu focus');
      await page.getByRole('button',{ name:'Open navigation',exact:true }).click(); await page.locator('.drawer-backdrop').click({ position:{ x:width-5,y:height/2 } });
      check(await page.locator('.sidebar').getAttribute('aria-hidden') === 'true','Backdrop closes drawer');
      await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
    } else check(geometry.menu === 'none','Desktop/tablet retains fixed sidebar');
    await page.screenshot({ path:'.local/phase4-' + width + 'x' + height + '.png' });
  }
  await page.setViewportSize({ width:1280,height:720 }); await page.goto(origin + '/leads/' + lead.id); await page.getByLabel('Message',{ exact:true }).waitFor();
  checkpoint = 'Stale browser draft verification'; if ((await client.from('leads').update({ city:'Oxford' }).eq('id',lead.id)).error) throw new Error();
  await page.getByRole('button',{ name:'Copy reviewed draft',exact:true }).click(); await page.getByText('Lead state is uncertain.',{ exact:false }).waitFor();
  check(await page.getByRole('button',{ name:'Copy reviewed draft',exact:true }).isDisabled(),'Older browser tab cannot copy invalidated outreach');
  await page.getByRole('button',{ name:'Reload lead',exact:true }).click(); await page.getByText('Stale / review required',{ exact:false }).waitFor();
  check((await page.getByLabel('Message',{ exact:true }).inputValue()) === 'Disposable user-edited and reviewed outreach.','Stale draft retains user text after evidence edit');
  await page.getByRole('button',{ name:'Sign out',exact:true }).click();
} catch (error) { console.error('FAIL: ' + checkpoint + ' (' + error.name + ')'); if (page) { console.log('UI route: ' + new URL(page.url()).pathname + '; alert: ' + await page.getByRole('alert').allTextContents()); console.log('Section headings: ' + await page.locator('h2').allTextContents()); console.log('Draft fields: ' + await page.locator('textarea[name="body"]').count()); if (!page.url().endsWith('/login')) await page.screenshot({ path:'.local/phase4-ui-failure.png' }); } process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  if (ids.length) { const deleted = await client.from('leads').delete().in('id',ids); if (deleted.error) { console.error('FAIL: UI fixture cleanup'); process.exitCode = 1; } }
  await client.auth.signOut({ scope:'local' }).catch(() => {});
}
