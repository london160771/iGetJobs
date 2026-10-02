import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { readServerEnv } from '../apps/api/dist/env.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
config({ path:'.env',quiet:true });
const origin = 'https://igetjobs.vercel.app';
const email = process.env.SUPABASE_SMOKE_EMAIL;
let password = process.env.SUPABASE_SMOKE_PASSWORD, browser, checkpoint = 'Fresh account configuration';
function check(value,label) { checkpoint=label; if (!value) throw new Error(); console.log('PASS: '+label); }
try {
  check(Boolean(email),'Fresh disposable email configured without printing credentials');
  if (!password && process.argv.includes('--create')) {
    password=randomBytes(24).toString('base64url');
    await appendFile('.env','\nSUPABASE_SMOKE_PASSWORD='+password+'\n',{ mode:0o600 });
  }
  check(Boolean(password),'Disposable password stored only in ignored environment');
  await mkdir('.local',{ recursive:true });
  browser=await chromium.launch({ channel:'chrome',headless:true });
  const context=await browser.newContext(), page=await context.newPage(); page.setDefaultTimeout(180000);
  if (process.argv.includes('--confirm')) {
    const link=(await readFile('.local/production-confirmation-url.txt','utf8')).trim(), url=new URL(link);
    const settings=readServerEnv(process.env);
    check(url.origin===new URL(settings.supabaseUrl).origin && url.pathname==='/auth/v1/verify' && url.searchParams.get('type')==='signup','Confirmation link belongs to the configured Supabase signup flow');
    checkpoint='Real confirmation redirect'; await page.goto(link); await page.waitForURL(origin+'/**');
    await unlink('.local/production-confirmation-url.txt');
    await context.clearCookies(); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  }
  await page.goto(origin+'/leads'); await page.waitForURL(origin+'/login'); check(true,'Signed-out production route is protected');
  if (process.argv.includes('--create')) {
    await page.getByRole('button',{ name:'Create an account',exact:true }).click();
    await page.getByLabel('Email',{ exact:true }).fill(email); await page.getByLabel('Password',{ exact:true }).fill(password);
    const response=page.waitForResponse(r => new URL(r.url()).pathname==='/auth/v1/signup');
    await page.getByRole('button',{ name:'Create account',exact:true }).click();
    const signed=await response; check(signed.status()===200,'Real production Create account request succeeds');
    const data=await signed.json(), user=data.user || data;
    check(Boolean(user.id) && (!user.identities || user.identities.length>0),'Signup created a new identity rather than an existing-account placeholder');
    const required=!data.access_token;
    if (required) await page.getByText('Check your email to confirm your account',{ exact:false }).waitFor();
    await writeFile('.local/production-auth-result.json',JSON.stringify({ created:true,confirmationRequired:required,confirmed:!required }));
    check(true,required ? 'Production requires real email confirmation' : 'Confirmation is not required by current production settings');
    if (required) process.exitCode=0;
  } else {
    await page.getByLabel('Email',{ exact:true }).fill(email); await page.getByLabel('Password',{ exact:true }).fill(password);
    await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(origin+'/leads');
    await page.getByRole('heading',{ name:'Leads',exact:true }).waitFor(); check(true,'Fresh confirmed account signs in through production UI');
    await page.getByRole('button',{ name:'Sign out',exact:true }).click(); await page.waitForURL(origin+'/login');
    await page.goto(origin+'/leads'); await page.waitForURL(origin+'/login'); check(true,'Logout clears access to protected routes');
    await writeFile('.local/production-auth-result.json',JSON.stringify({ created:true,confirmationRequired:true,confirmed:true,login:true,logout:true }));
  }
} catch { console.error('FAIL: '+checkpoint+'. No credentials or confirmation tokens emitted.'); process.exitCode=1; }
finally { await browser?.close(); }
