import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { readServerEnv } from '../apps/api/dist/env.js';
config({ path:'.env',quiet:true });
const url = new URL(process.env.VERIFY_WEB_URL || 'http://127.0.0.1:4173/');
if ((!['127.0.0.1','localhost','[::1]'].includes(url.hostname) && !(url.protocol === 'https:' && /^igetjobs(?:-[a-z0-9-]+)?\.vercel\.app$/.test(url.hostname))) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Use the approved Vercel origin or loopback built preview.');
const clients = [], ids = []; let checkpoint = 'Configuration';
function check(value,label) { checkpoint = label; if (!value) throw new Error(); console.log('PASS: ' + label); }
try {
  const settings = readServerEnv(process.env), accounts = [];
  for (const suffix of ['A','B']) {
    const client = createClient(settings.supabaseUrl,settings.supabaseKey,{ auth:{ persistSession:false,autoRefreshToken:false },global:{ fetch:(input,init) => fetch(input,{ ...init,signal:AbortSignal.timeout(15000) }) } }); clients.push(client);
    const signed = await client.auth.signInWithPassword({ email:process.env['SUPABASE_TEST_EMAIL_' + suffix],password:process.env['SUPABASE_TEST_PASSWORD_' + suffix] });
    check(!signed.error && signed.data.session,'Smoke account ' + suffix + ' sign-in'); accounts.push({ client,token:signed.data.session.access_token });
  }
  const [a,b] = accounts;
  async function request(path,account = a,body,method = 'POST') {
    checkpoint = 'Request ' + path.split('?')[0];
    const response = await fetch(url.origin + path,{ method:body === undefined ? 'GET' : method,headers:{ ...(account ? { Authorization:'Bearer ' + account.token } : {}),...(body === undefined ? {} : { 'Content-Type':'application/json' }) },...(body === undefined ? {} : { body:JSON.stringify(body) }),signal:AbortSignal.timeout(180000) });
    return { status:response.status,data:await response.json() };
  }
  check((await request('/api/management/counts',null)).status === 401,'Frontend-proxied API requires authentication');
  check((await request('/api/outreach/config')).data.hunterConfigured === false,'Hunter remains disabled');
  const configResult = await request('/api/discovery/config'); check(configResult.status === 200,'Discovery configuration reachable through frontend proxy');
  const baseline = (await request('/api/management/counts')).data;
  const marker = randomUUID(), city = 'Smoke-' + marker;
  const csv = 'businessName,country,city,address,website\n' + ['Missing','Poor','Acceptable'].map((kind,index) => `Disposable ${kind} ${marker},GB,${city},${index + 1} Fixture Street,${['','https://example.com/igetjobs-smoke-not-found','https://example.com/'][index]}`).join('\n');
  const preview = await request('/api/discovery/import',a,{ csv,filename:'disposable-v1-smoke.csv' }); check(preview.status === 200 && preview.data.rows.length === 3,'CSV creates a normalized three-row preview');
  ids.push(...preview.data.rows.map(row => row.lead.id)); await mkdir('.local',{ recursive:true }); await writeFile('.local/deployed-smoke-ids.json',JSON.stringify(ids));
  const saved = await request('/api/discovery/save',a,{ previewId:preview.data.id,selections:preview.data.rows.map(row => ({ id:row.lead.id,action:row.duplicate.kind === 'new' ? 'save' : 'separate' })) });
  check(saved.status === 200 && saved.data.results.every(row => row.status === 'saved'),'Explicit reviewed fixture saves persist');
  const duplicate = await request('/api/discovery/import',a,{ csv,filename:'disposable-v1-smoke.csv' }); check(duplicate.status === 200 && duplicate.data.rows.every(row => row.duplicate.kind !== 'new'),'Saved fixture records are detected as duplicates');
  const kinds = ['NO_WEBSITE','POOR_WEBSITE','ACCEPTABLE_WEBSITE']; let missing;
  for (let index = 0; index < ids.length; index++) {
    if (index > 0) await new Promise(resolve => setTimeout(resolve,5100));
    const audited = await request('/api/leads/' + ids[index] + '/audit',a,{}), lead = audited.data.lead;
    check(audited.status === 200 && lead.classification === kinds[index],'Measured classification ' + kinds[index]);
    check(Number.isFinite(lead.score) && lead.score >= 0 && lead.score <= 100 && lead.scoreReasons.length > 0 && lead.scoreReasons.reduce((sum,row) => sum + row.points,0) === lead.score,'Score math and explicit reasons persist');
    if (index === 1) check(lead.audit.failure === 'http' && lead.audit.metrics.status === 404,'Poor fixture reflects a measured HTTP 404, with page quality unverified');
    if (index === 2) check(lead.audit.state === 'reachable' && lead.audit.metrics.bytes > 0,'Real public fixture page was measured; no injected audit');
    if (index === 0) missing = lead;
  }
  const filtered = await request('/api/management/leads?city=' + city + '&sort=score_desc'); check(filtered.status === 200 && filtered.data.total === 3 && filtered.data.leads[0].id === missing.id,'Filtering/sorting match saved fixture assessments');
  check((await request('/api/leads/' + missing.id,b)).status === 404,'Other user cannot read fixture lead');
  check((await request('/api/management/leads?city=' + city,b)).data.total === 0,'Other user collection excludes fixtures');
  const due = new Date().toISOString().slice(0,10) + 'T12:00:00.000Z';
  const changed = await request('/api/management/leads/' + missing.id,a,{ expectedUpdatedAt:missing.updatedAt,notes:'Disposable persistent smoke note',status:'Qualified',followUpAt:due },'PATCH');
  check(changed.status === 200,'Notes/status/follow-up management persists'); missing = changed.data.lead;
  check(missing.notes === 'Disposable persistent smoke note' && missing.status === 'Qualified' && Date.parse(missing.followUpAt) === Date.parse(due) && missing.audit,'Management-only edits retain the assessment');
  const counts = (await request('/api/management/counts')).data;
  check(counts.total === baseline.total + 3 && counts.qualified === baseline.qualified + 1 && counts.noWebsite === baseline.noWebsite + 1 && counts.poorWebsite === baseline.poorWebsite + 1,'Dashboard counts match fixture state');
  async function action(name,body = {}) { const result = await request('/api/outreach/' + missing.id + '/' + name,a,{ expectedUpdatedAt:missing.updatedAt,...body }); check(result.status === 200,'Manual outreach ' + name); missing = result.data.lead; }
  await action('generate'); check(missing.outreachDraft.approval === 'pending','Generated draft requires human review');
  await action('save',{ subject:missing.outreachDraft.subject,body:missing.outreachDraft.body + '\n\nDisposable reviewed fixture edit.',approve:true });
  await action('copy'); // Clipboard itself is verified separately in the browser.
  const old = missing.updatedAt; await action('contacted'); const events = missing.activity.length; await action('contacted'); check(events === missing.activity.length,'Repeated Contacted action does not duplicate history');
  check((await request('/api/outreach/' + missing.id + '/contacted',a,{ expectedUpdatedAt:old })).status === 409,'Stale writes remain rejected');
  await a.client.auth.signOut({ scope:'local' });
  const signedAgain = await a.client.auth.signInWithPassword({ email:process.env.SUPABASE_TEST_EMAIL_A,password:process.env.SUPABASE_TEST_PASSWORD_A }); check(!signedAgain.error,'Logout/login succeeds'); a.token = signedAgain.data.session.access_token;
  const reloaded = (await request('/api/leads/' + missing.id)).data.lead;
  check(reloaded.notes === missing.notes && reloaded.outreachDraft.body === missing.outreachDraft.body && reloaded.status === 'Contacted','Notes/reviewed draft/status survive logout/login');
  if (process.argv.includes('--live-source')) {
    const query = { source:'OSM',country:'GB',city:'Bath',niche:'dentists' };
    const source = await request('/api/discovery/search',a,query); check(source.status === 200 && source.data.rows.length > 0,'Frontend-proxied live OSM discovery');
    const cached = await request('/api/discovery/search',a,query); check(cached.status === 200 && cached.data.cached,'Frontend-proxied OSM repeated query uses cache');
  }
  check(true,'V1 smoke workflow complete; no sending occurs');
} catch { console.error('FAIL: ' + checkpoint + '. No credentials emitted.'); process.exitCode = 1; }
finally {
  if (clients[0] && ids.length && (await clients[0].from('leads').delete().in('id',ids)).error) { console.error('FAIL: Smoke fixture cleanup'); process.exitCode = 1; }
  for (const client of clients) await client.auth.signOut({ scope:'local' }).catch(() => {});
}
