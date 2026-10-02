/* global window */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readServerEnv } from '../apps/api/dist/env.js';
import { normalizeLead } from '../apps/api/dist/discovery/normalize.js';
import { auditLead } from '../apps/api/dist/audit/engine.js';
import { templateText, outreachVersion } from '@igetjobs/shared';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
config({ path:'.env',quiet:true });
const target = new URL(process.env.VERIFY_WEB_URL || 'http://127.0.0.1:4173/');
if ((!['127.0.0.1','localhost','[::1]'].includes(target.hostname) && !(target.protocol === 'https:' && target.hostname === 'igetjobs.vercel.app')) || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Use the approved production or loopback origin.');
const settings = readServerEnv(process.env);
const accountB = createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false },global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } });
let browser, checkpoint = 'Browser setup';
function check(condition,label) { checkpoint = label; if (!condition) throw new Error(); console.log('PASS: ' + label); }
try {
  const signedB = await accountB.auth.signInWithPassword({ email:process.env.SUPABASE_TEST_EMAIL_B,password:process.env.SUPABASE_TEST_PASSWORD_B }); check(!signedB.error,'Second disposable account authenticates');
  checkpoint = 'Chrome startup'; browser = await chromium.launch({ channel:'chrome',headless:true });
  const page = await browser.newPage({ viewport:{ width:1280,height:720 } }); page.setDefaultTimeout(90000);
  const email = process.env.SUPABASE_SMOKE_EMAIL || process.env.SUPABASE_TEST_EMAIL_A, password = process.env.SUPABASE_SMOKE_PASSWORD || process.env.SUPABASE_TEST_PASSWORD_A;
  checkpoint = 'Login page load'; await page.goto(target.origin + '/login');
  check(await page.getByRole('button',{ name:'Create an account',exact:true }).count() === 0,'No public signup control');
  async function login() { await page.getByLabel('Email',{ exact:true }).fill(email); await page.getByLabel('Password',{ exact:true }).fill(password); await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(url => url.pathname !== '/login'); }
  checkpoint = 'Existing-account login'; await login();
  async function revalidate(refresh = false) {
    const verified = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/v1/user' && response.status() === 200);
    const refreshed = refresh ? page.waitForResponse(response => new URL(response.url()).pathname === '/auth/v1/token' && new URL(response.url()).searchParams.get('grant_type') === 'refresh_token' && response.status() === 200) : null;
    await page.evaluate(force => {
      if (force) {
        const key = Object.keys(localStorage).find(key => /^sb-.*-auth-token$/.test(key));
        if (!key) throw new Error('Session storage unavailable');
        const value = JSON.parse(localStorage.getItem(key)); value.expires_at = 0;
        localStorage.setItem(key,JSON.stringify(value));
      }
      window.dispatchEvent(new Event('visibilitychange'));
    },refresh);
    await refreshed; await verified;
  }
  await page.goto(target.origin + '/search'); await page.getByLabel('City',{ exact:true }).fill('Unsaved search marker');
  await revalidate(); check(await page.getByLabel('City',{ exact:true }).inputValue() === 'Unsaved search marker','Tab revalidation preserves unsaved Search input');
  await revalidate(true); check(await page.getByLabel('City',{ exact:true }).inputValue() === 'Unsaved search marker','Real TOKEN_REFRESHED preserves unsaved Search input');
  // Explicit browser-only lead GET fixture: no generated draft/notes are saved,
  // and no database record or provider allowance is created/consumed here.
  const lead = normalizeLead({ businessName:'Read-only Auth UI fixture',country:'GB',city:'Bath',sourceId:'auth-ui-fixture',metadata:{} },'CSV').lead;
  Object.assign(lead,await auditLead(lead)); const generated = templateText(lead);
  lead.outreachDraft = { ...generated,version:outreachVersion,sourceKey:'browser-fixture',stale:false,edited:false,approval:'approved',updatedAt:lead.updatedAt,generatedSubject:generated.subject,generatedBody:generated.body };
  await page.route('**/api/leads/' + lead.id,route => {
    const foreign = route.request().headers().authorization === 'Bearer ' + signedB.data.session.access_token;
    return route.fulfill({ status:foreign ? 404 : 200,contentType:'application/json',body:JSON.stringify(foreign ? { error:'Lead not found.' } : { lead,resolution:{ candidates:[],evidence:[],requiresChoice:false,invalidCount:0 } }) });
  });
  await page.goto(target.origin + '/leads/' + lead.id); await page.getByLabel('Notes',{ exact:true }).fill('Unsaved notes marker');
  await revalidate(); check(await page.getByLabel('Notes',{ exact:true }).inputValue() === 'Unsaved notes marker','Tab revalidation preserves unsaved notes');
  await revalidate(true); check(await page.getByLabel('Notes',{ exact:true }).inputValue() === 'Unsaved notes marker','Real TOKEN_REFRESHED preserves unsaved notes');
  await page.getByRole('button',{ name:'Discard changes',exact:true }).click();
  await page.getByLabel('Message',{ exact:true }).fill('Unsaved outreach marker');
  await revalidate(); check(await page.getByLabel('Message',{ exact:true }).inputValue() === 'Unsaved outreach marker','Tab revalidation preserves unsaved outreach');
  await revalidate(true); check(await page.getByLabel('Message',{ exact:true }).inputValue() === 'Unsaved outreach marker','Real TOKEN_REFRESHED preserves unsaved outreach');
  // Supabase's actual cross-tab auth channel establishes another verified account.
  checkpoint = 'Cross-account reset';
  await page.evaluate(session => { const key = Object.keys(localStorage).find(key => /^sb-.*-auth-token$/.test(key)); localStorage.setItem(key,JSON.stringify(session)); const channel = new BroadcastChannel(key); channel.postMessage({ event:'SIGNED_IN',session }); channel.close(); },signedB.data.session);
  await page.getByRole('alert').filter({ hasText:'Lead not found.' }).waitFor();
  check(await page.getByLabel('Message',{ exact:true }).count() === 0 && await page.getByLabel('Notes',{ exact:true }).count() === 0,'Switching accounts removes previous protected editor state');
  await page.getByRole('button',{ name:'Sign out',exact:true }).click(); await page.waitForURL(target.origin + '/login');
  await page.goto(target.origin + '/search'); await page.waitForURL(target.origin + '/login'); check(true,'Actual logout clears protected state');
  await login(); await page.goto(target.origin + '/search'); await page.getByLabel('City',{ exact:true }).waitFor();
  check(await page.getByLabel('City',{ exact:true }).inputValue() === '','Logout/login starts with clean Search state');
  await page.getByRole('button',{ name:'Sign out',exact:true }).click(); await page.waitForURL(target.origin + '/login');
} catch (error) { const kind = error instanceof Error ? error.name : 'Unknown'; const network = error instanceof Error ? error.message.match(/net::ERR_[A-Z_]+/)?.[0] : null; console.error('FAIL: ' + checkpoint + ' (' + kind + (network ? ', ' + network : '') + '). No credentials emitted.'); process.exitCode = 1; }
finally { await browser?.close(); await accountB.auth.signOut({ scope:'local' }).catch(() => {}); }

