import { config } from 'dotenv';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
config({ path:'.env',quiet:true });
if (process.argv.includes('--create') || process.argv.includes('--confirm')) {
  console.error('Public signup verification is retired. Use an existing confirmed account.'); process.exit(1);
}
const origin = 'https://igetjobs.vercel.app';
let browser, checkpoint = 'Existing confirmed account';
try {
  browser = await chromium.launch({ channel:'chrome',headless:true });
  const page = await browser.newPage(); page.setDefaultTimeout(180000);
  await page.goto(origin + '/leads'); await page.waitForURL(origin + '/login');
  if (await page.getByRole('button',{ name:'Create an account',exact:true }).count()) throw new Error();
  console.log('PASS: Private production signup absent; signed-out routes protected');
  await page.getByLabel('Email',{ exact:true }).fill(process.env.SUPABASE_SMOKE_EMAIL);
  await page.getByLabel('Password',{ exact:true }).fill(process.env.SUPABASE_SMOKE_PASSWORD);
  checkpoint = 'Existing-account login'; await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await page.waitForURL(origin + '/leads');
  await page.getByRole('heading',{ name:'Leads',exact:true }).waitFor();
  console.log('PASS: Existing confirmed account signs in through production UI');
  checkpoint = 'Logout'; await page.getByRole('button',{ name:'Sign out',exact:true }).click(); await page.waitForURL(origin + '/login');
  await page.goto(origin + '/leads'); await page.waitForURL(origin + '/login');
  console.log('PASS: Logout clears protected access');
} catch { console.error('FAIL: ' + checkpoint + '. No credentials emitted.'); process.exitCode = 1; }
finally { await browser?.close(); }
