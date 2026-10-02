import { config,parse } from 'dotenv';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
config({path:'.env',quiet:true});
let checkpoint='Configuration';
try {
  const settings={...process.env};
  for(const path of ['.env','apps/api/.env','apps/web/.env']) { try { Object.assign(settings,parse(await readFile(path))); } catch { /* Optional local file. */ } }
  const privateValues=Object.entries(settings).filter(([key,value]) => /SUPABASE|(?:SERPAPI|GEOAPIFY|HUNTER|RENDER|VERCEL)_(?:API_KEY|TOKEN)|DATABASE_URL/.test(key) && value?.length>=5 && !/^(?:VITE_)?SUPABASE_(?:URL|ANON_KEY|PUBLISHABLE_KEY)$/.test(key)).map(([,value])=>value);
  const origin='https://igetjobs.vercel.app';
  async function download(path) {
    const response=await fetch(origin+path,{signal:AbortSignal.timeout(90000)}), reader=response.body.getReader();let size=0;const chunks=[];
    for (;;) { const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>5*1024*1024){await reader.cancel();throw new Error();}chunks.push(part.value); }
    const text=Buffer.concat(chunks).toString();if(privateValues.some(value=>text.includes(value)))throw new Error();return {response,text};
  }
  checkpoint='Frontend headers'; const index=await download('/');
  if(index.response.status!==200 || !index.response.headers.get('content-security-policy')?.includes("object-src 'none'") || index.response.headers.get('x-frame-options')!=='DENY') throw new Error();
  console.log('PASS: Deployed frontend security headers');
  checkpoint='Production assets'; const queue=[...index.text.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match=>match[1]),seen=new Set();
  await mkdir('.local/production-assets',{recursive:true});
  while(queue.length) {
    const path=queue.shift();if(seen.has(path))continue;if(!/^\/assets\/[\w.-]+\.(?:js|css)$/.test(path)||seen.size>=100)throw new Error();seen.add(path);
    const file=await download(path);if(!file.response.ok)throw new Error();await writeFile('.local/production-assets/'+path.split('/').pop(),file.text);
    for(const match of file.text.matchAll(/["'](?:\.\/|\/assets\/)([\w.-]+\.(?:js|css))["']/g))queue.push('/assets/'+match[1]);
  }
  console.log('PASS: '+seen.size+' deployed frontend assets expose no known private configuration');
  checkpoint='Private paths';for(const path of ['/.env','/apps/api/.env','/api/missing']) { if(![403,404].includes((await download(path)).response.status))throw new Error(); }
  const health=await download('/api/health');if(health.response.headers.get('cache-control')!=='no-store'||health.response.headers.get('x-content-type-options')!=='nosniff')throw new Error();
  console.log('PASS: Private paths denied; API no-store/nosniff headers');
} catch { console.error('FAIL: '+checkpoint+'. No credential values emitted.');process.exitCode=1; }
