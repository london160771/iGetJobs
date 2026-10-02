import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readServerEnv } from '../apps/api/dist/env.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
config({ path:'.env',quiet:true });
const origin='https://igetjobs.vercel.app', ids=[];
const settings=readServerEnv(process.env);
const client=createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false },global:{ fetch:(input,init)=>fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } });
let browser, page, checkpoint='Fresh account sign-in';
function check(value,label) { checkpoint=label; if (!value) throw new Error(); console.log('PASS: '+label); }
try {
  const signed=await client.auth.signInWithPassword({ email:process.env.SUPABASE_SMOKE_EMAIL,password:process.env.SUPABASE_SMOKE_PASSWORD });
  check(!signed.error && signed.data.session,'Fresh disposable account authenticates');
  await mkdir('.local',{ recursive:true });
  checkpoint='Production login page'; browser=await chromium.launch({ channel:'chrome',headless:true });
  const context=await browser.newContext({ viewport:{ width:390,height:844 } }); page=await context.newPage(); page.setDefaultTimeout(90000);
  await page.goto(origin+'/login');
  await page.getByLabel('Email',{ exact:true }).fill(process.env.SUPABASE_SMOKE_EMAIL);
  await page.getByLabel('Password',{ exact:true }).fill(process.env.SUPABASE_SMOKE_PASSWORD);
  checkpoint='Normal production UI sign-in';
  await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(url=>url.pathname!=='/login');
  check(true,'Normal mobile production sign-in succeeds');
  checkpoint='Production Search configuration'; await page.goto(origin+'/search');
  await page.getByLabel('Source').selectOption('CSV');
  await page.getByLabel('Country').selectOption('GB');
  await page.getByLabel('CSV file',{ exact:true }).setInputFiles({ name:'malformed-fixture.csv',mimeType:'text/csv',buffer:Buffer.from('businessName\n"unclosed') });
  await page.getByRole('button',{ name:'Preview CSV',exact:true }).click();
  await page.getByRole('alert').waitFor(); check(/CSV|quote|quoted/i.test(await page.getByRole('alert').innerText()),'Malformed CSV shows useful feedback in production UI');
  const name='Disposable browser CSV '+randomUUID();
  const csv='businessName,country,city,niche,address,website\n'+name+',GB,London,Dentists,1 Fixture Street,//example.com/?api_key=fixture&lang=en\n';
  await page.getByLabel('CSV file',{ exact:true }).setInputFiles({ name:'disposable-browser.csv',mimeType:'text/csv',buffer:Buffer.from(csv) });
  const importing=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/discovery/import');
  await page.getByRole('button',{ name:'Preview CSV',exact:true }).click();
  const imported=await importing, preview=await imported.json();
  check(imported.status()===200 && preview.rows.length===1,'Mobile CSV upload creates a real production preview');
  check(!JSON.stringify(preview).includes('api_key') && !JSON.stringify(preview).includes('fixture&'),'CSV preview strips credential-bearing URL parameters');
  ids.push(preview.rows[0].lead.id); await writeFile('.local/production-browser-discovery-ids.json',JSON.stringify(ids));
  await page.getByRole('heading',{ name:'1 results to review',exact:true }).waitFor();
  await page.getByRole('button',{ name:'Save selected (1)',exact:true }).click();
  await page.getByText('1 saved · 0 sources added.',{ exact:false }).waitFor();
  check(true,'Reviewed mobile CSV save succeeds');
  await page.getByRole('link',{ name:'View saved leads →',exact:true }).click();
  await page.getByRole('link',{ name,exact:true }).waitFor(); await page.reload();
  await page.getByRole('link',{ name,exact:true }).waitFor(); check(true,'Browser-saved CSV lead survives route navigation and reload');
  const persisted=await client.from('leads').select('website,provenance').eq('id',ids[0]).single();
  check(!persisted.error && !JSON.stringify(persisted.data).includes('api_key'),'Production persisted CSV provenance is clean');
  await page.goto(origin+'/search'); await page.getByLabel('Source').selectOption('SERPAPI');
  await page.getByLabel('Country').selectOption('GB'); await page.getByLabel('Niche').selectOption('dentists'); await page.getByLabel('City',{ exact:true }).fill('Oxford');
  const finding=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/discovery/search');
  await page.getByRole('button',{ name:'Find leads',exact:true }).click(); const found=await finding, results=await found.json();
  check(found.status()===200 && results.rows.length>0,'Actual production Search UI displays live SerpAPI results');
  await page.getByRole('heading',{ name:results.rows.length+' results to review',exact:true }).waitFor();
  for (const choice of await page.getByRole('combobox',{ name:/Save choice for/ }).all()) await choice.selectOption('skip');
  const row=results.rows.find(item=>item.duplicate.kind==='new') || results.rows[0];
  await page.getByRole('combobox',{ name:'Save choice for '+row.lead.businessName,exact:true }).selectOption(row.duplicate.kind==='new'?'save':'separate');
  ids.push(row.lead.id); await writeFile('.local/production-browser-discovery-ids.json',JSON.stringify(ids));
  await page.getByRole('button',{ name:'Save selected (1)',exact:true }).click(); await page.getByText('1 saved · 0 sources added.',{ exact:false }).waitFor();
  await page.screenshot({ path:'.local/production-discovery-mobile.png',fullPage:false });
  check(true,'One explicitly reviewed SerpAPI business saves through the mobile UI');
  await page.getByRole('button',{ name:'Sign out',exact:true }).click(); await page.waitForURL(origin+'/login');
} catch { console.error('FAIL: '+checkpoint+'. No credentials emitted.'); if (page) console.log('Page path: '+new URL(page.url()).pathname); process.exitCode=1; }
finally {
  await browser?.close();
  if (ids.length && (await client.from('leads').delete().in('id',ids)).error) { console.error('FAIL: Disposable browser fixture cleanup'); process.exitCode=1; }
  await client.auth.signOut({ scope:'local' }).catch(()=>{});
}
