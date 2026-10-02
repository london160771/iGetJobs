import { readFileSync,readdirSync,existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
let checkpoint = 'local configuration';
try {
  const local = { ...process.env };
  for (const path of ['.env','apps/api/.env','apps/web/.env']) if (existsSync(path)) Object.assign(local,parse(readFileSync(path)));
  const pairs = Object.entries(local).filter(([key,value]) => /PROVIDER_ALLOWED_USER_IDS|SUPABASE|(?:SERPAPI|GEOAPIFY|HUNTER|RENDER|VERCEL)_(?:API_KEY|TOKEN)|DATABASE_URL/.test(key) && value?.length >= 5);
  const privateValues = pairs.filter(([key]) => !/^(?:VITE_)?SUPABASE_(?:URL|ANON_KEY|PUBLISHABLE_KEY)$/.test(key)).flatMap(([key,value]) => key === 'PROVIDER_ALLOWED_USER_IDS' ? value.split(',').map(item => item.trim()).filter(Boolean) : [value]);
  const allValues = pairs.flatMap(([key,value]) => key === 'PROVIDER_ALLOWED_USER_IDS' ? value.split(',').map(item => item.trim()).filter(Boolean) : [value]);
  checkpoint = 'publishable files';
  const files = execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{ encoding:'utf8',stdio:['pipe','pipe','ignore'] }).split('\0').filter(Boolean);
  if (files.some(path => /(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith('.env.example'))) throw new Error();
  for (const file of files) if (allValues.some(value => readFileSync(file,'utf8').includes(value))) throw new Error();
  checkpoint = 'Git history';
  const history = execFileSync('git',['log','--all','--format=','-p'],{ encoding:'utf8',maxBuffer:32*1024*1024,stdio:['pipe','pipe','ignore'] });
  if (allValues.some(value => history.includes(value))) throw new Error();
  checkpoint = 'web output';
  const builds = readdirSync('apps/web/dist',{ recursive:true }).filter(path => /\.(?:js|css|html)$/.test(path));
  for (const file of builds) if (privateValues.some(value => readFileSync('apps/web/dist/' + file,'utf8').includes(value))) throw new Error();
  console.log('PASS: Secret scan of ' + files.length + ' publishable files, Git history and ' + builds.length + ' web outputs. No values emitted.');
} catch { console.error('FAIL: Secret scan at ' + checkpoint + '. No values emitted.'); process.exitCode = 1; }
