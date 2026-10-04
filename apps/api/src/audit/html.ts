import { load } from 'cheerio';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { AuditCheck, ScoringConfig } from '@igetjobs/shared';
import type { WebsiteFetchResult } from './fetcher.js';
import { AuditManualReviewError } from './manual-review.js';

export const analysisLimits = { htmlBytes: 128 * 1024, textChars: 64 * 1024, nodes: 4000, depth: 64, startupMs: 5000, workerMs: 750, tokenChars: 254 };
const htmlTooLarge = (measuredHtmlBytes: number) => new AuditManualReviewError('HTML_TOO_LARGE', 'Static HTML exceeded the 128 KB analysis limit; quality remains unverified.', { measuredHtmlBytes, htmlByteLimit: analysisLimits.htmlBytes });
function checkHtmlSize(body: string) {
  const measuredHtmlBytes = Buffer.byteLength(body);
  if (body.length > analysisLimits.htmlBytes || measuredHtmlBytes > analysisLimits.htmlBytes) throw htmlTooLarge(measuredHtmlBytes);
}

// Each candidate has a fixed maximum length. No regex searches unbounded text.
function emailToken(input: string): boolean {
  const token = input.replace(/^[.!?]+|[.!?]+$/g, '');
  const at = token.indexOf('@');
  if (at < 1 || at > 64 || at !== token.lastIndexOf('@')) return false;
  const local = token.slice(0, at), domain = token.slice(at + 1);
  if (/[^a-z0-9.!#$%&'*+/=?^_`{|}~-]/i.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => label.length > 0 && label.length <= 63 && !/[^a-z0-9-]/i.test(label) && !label.startsWith('-') && !label.endsWith('-'))
    && /^[a-z]{2,63}$/i.test(labels.at(-1)!);
}
export function hasContactText(text: string): boolean {
  if (text.length > analysisLimits.textChars) throw new AuditManualReviewError('TEXT_TOO_LARGE', 'Visible text exceeded the 64,000 character analysis limit; quality remains unverified.', { measuredTextLength: text.length, textCharLimit: analysisLimits.textChars });
  let start = 0, phoneDigits = 0, phoneChars = 0;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index] || '';
    const digit = char >= '0' && char <= '9';
    if (digit || (phoneDigits > 0 && ' +()-'.includes(char) && char !== '')) {
      phoneChars++; if (digit) phoneDigits++;
      if (phoneChars <= 40 && phoneDigits >= 9 && digit) return true;
    } else { phoneDigits = 0; phoneChars = 0; }
    if (index === text.length || char.charCodeAt(0) <= 32 || ',;<>()[]{}:"\\'.includes(char)) {
      const length = index - start;
      if (length > 0 && length <= analysisLimits.tokenChars && emailToken(text.slice(start, index))) return true;
      start = index + 1;
    }
  }
  return false;
}

export function inspectHtml(result: WebsiteFetchResult, config: ScoringConfig): AuditCheck[] {
  checkHtmlSize(result.body);
  const $ = load(result.body);
  // Bound tree walks before selectors/text extraction, including deeply nested HTML.
  const pending = $.root()[0]!.children.map(node => ({ node, depth: 1 })); let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++nodes > analysisLimits.nodes) throw new AuditManualReviewError('DOM_TOO_MANY_NODES', 'Page DOM exceeded 4,000 nodes; quality remains unverified.', { measuredNodes: nodes, nodeLimit: analysisLimits.nodes });
    if (depth > analysisLimits.depth) throw new AuditManualReviewError('DOM_TOO_DEEP', 'Page DOM exceeded 64 levels; quality remains unverified.', { measuredDepth: depth, depthLimit: analysisLimits.depth });
    if ('children' in node) for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
  }
  const title = $('title').text().trim();
  const viewport = $('meta').toArray().filter(node => $(node).attr('name')?.toLowerCase() === 'viewport').map(node => $(node).attr('content') || '').join(';');
  const goodViewport = /(?:^|[,;\s])width\s*=\s*device-width(?:[,;\s]|$)/i.test(viewport);
  $('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
  $('[style]').each((_index, node) => { if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test($(node).attr('style') || '')) $(node).remove(); });
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  if (visibleText.length > analysisLimits.textChars) throw new AuditManualReviewError('TEXT_TOO_LARGE', 'Visible text exceeded the 64,000 character analysis limit; quality remains unverified.', { measuredTextLength: visibleText.length, textCharLimit: analysisLimits.textChars });
  const anchors = $('a[href]').toArray();
  const contact = anchors.some(node => /^(?:mailto:|tel:)/i.test($(node).attr('href') || '')) || hasContactText(visibleText);
  const ctas = $('a[href],button,input[type="submit"]').toArray().filter(node => /\b(?:contact|book|call|appointment|quote|enquir(?:e|y)|inquir(?:e|y)|reserve|consult|schedule|get started)\b/i.test($(node).text() || $(node).attr('value') || ''));
  const structure = Boolean(title) && $('h1').length > 0 && visibleText.length >= 100;
  const ids = new Set($('[id],a[name]').toArray().flatMap(node => [$(node).attr('id'), $(node).attr('name')].filter((value): value is string => Boolean(value))));
  let brokenFragments = 0;
  for (const node of anchors) {
    const href = $(node).attr('href')!.trim();
    if (href.startsWith('#') && href.length > 1) { try { if (!ids.has(decodeURIComponent(href.slice(1)))) brokenFragments++; } catch { brokenFragments++; } }
  }
  const check = (key: string, label: string, pass: boolean, evidence: string): AuditCheck => ({ key, label, outcome: pass ? 'pass' : 'fail', evidence });
  return [
    check('https', 'HTTPS response', result.url.startsWith('https:'), `Final response used ${new URL(result.url).protocol.replace(':', '').toUpperCase()}.`),
    check('viewport', 'Mobile viewport declaration', goodViewport, goodViewport ? 'width=device-width meta detected.' : 'No width=device-width meta detected in fetched HTML.'),
    { key: 'mobile_width', label: 'CSS mobile width behavior', outcome: 'unknown', evidence: 'CSS selector applicability, media conditions, cascade and rendered overflow were not verified; width declarations earn no penalty.' },
    check('performance', 'Bounded response time', result.durationMs <= config.slowMs, `${result.durationMs}ms for DNS/connection/redirects/body; threshold ${config.slowMs}ms. Not browser performance.`),
    check('page_size', 'HTML response size', result.bytes <= config.largeBytes, `${result.bytes} bytes of HTML; threshold ${config.largeBytes}. Assets excluded.`),
    check('contact', 'Contact indicators in fetched HTML', contact, contact ? 'Email/telephone link or bounded visible-text pattern detected; not verified contactability.' : 'No email/telephone indicators detected in fetched HTML (email tokens up to 254 characters; phone runs up to 40).'),
    check('cta', 'CTA text indicators', ctas.length > 0, `${ctas.length} contact/booking/quote action labels detected in fetched HTML; click behavior not tested.`),
    check('structure', 'Basic document structure', structure, `Non-empty title: ${Boolean(title)}; h1 count: ${$('h1').length}; text length: ${visibleText.length}.`),
    { key: 'links', label: 'Local fragment link targets', outcome: brokenFragments ? 'fail' : anchors.length ? 'pass' : 'unknown', evidence: `${brokenFragments} missing/malformed in-page targets. Other links were not fetched or verified.` },
    { key: 'rendered_mobile', label: 'Rendered mobile usability', outcome: 'unknown', evidence: 'No browser rendering, external assets, or scripts executed; static indicators only.' }
  ];
}

// All parsing/selectors run off the API event loop. No page scripts are executed.
export function inspectHtmlIsolated(result: WebsiteFetchResult, config: ScoringConfig): Promise<AuditCheck[]> {
  checkHtmlSize(result.body);
  return new Promise((resolve, reject) => {
    const source = new URL(import.meta.url);
    const typescript = source.pathname.endsWith('.ts');
    // tsx is already the development runner; production loads compiled JS directly.
    const entry = typescript ? `import('tsx/esm/api').then(({ register }) => { register(); return import(${JSON.stringify(source.href)}); });` : source;
    let worker: Worker;
    try { worker = new Worker(entry, { eval: typescript, execArgv: [], workerData: { htmlAudit: true, result, config }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 } }); }
    catch { reject(new AuditManualReviewError('OTHER_UNVERIFIED', 'Automatic HTML inspection could not start; quality remains unverified.')); return; }
    let settled = false, ready = false;
    // Await termination before settling: callers/tests cannot overlap a leftover
    // worker with the next inspection. Every success/failure shares this cleanup.
    const finish = (outcome?: { checks?: AuditCheck[]; error?: AuditManualReviewError }) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate().then(() => outcome?.checks ? resolve(outcome.checks) : reject(outcome?.error || new AuditManualReviewError('OTHER_UNVERIFIED', 'Automatic HTML inspection could not complete; quality remains unverified.')), () => reject(outcome?.error || new AuditManualReviewError('OTHER_UNVERIFIED', 'Automatic HTML inspection could not complete; quality remains unverified.')));
    };
    let timer = setTimeout(() => finish({ error: new AuditManualReviewError('ANALYSIS_TIMEOUT', 'Static HTML analysis exceeded the bounded processing time; quality remains unverified.', { stage: 'worker_startup', timeLimitMs: analysisLimits.startupMs }) }), analysisLimits.startupMs);
    worker.on('message', (message: { ready?: boolean; checks?: AuditCheck[]; failure?: { reason: import('@igetjobs/shared').AuditAttemptReason; message: string; detail: import('@igetjobs/shared').AuditAttemptDetail | null } }) => {
      if (settled) return;
      if (message.ready && !ready) {
        ready = true; clearTimeout(timer);
        timer = setTimeout(() => finish({ error: new AuditManualReviewError('ANALYSIS_TIMEOUT', 'Static HTML analysis exceeded the bounded processing time; quality remains unverified.', { stage: 'analysis', timeLimitMs: analysisLimits.workerMs }) }), analysisLimits.workerMs);
        try { worker.postMessage('inspect'); } catch { finish({ error: new AuditManualReviewError('OTHER_UNVERIFIED', 'Automatic HTML inspection could not start; quality remains unverified.') }); }
        return;
      }
      if (message.failure) finish({ error: new AuditManualReviewError(message.failure.reason, message.failure.message, message.failure.detail) });
      else finish(message.checks ? { checks: message.checks } : undefined);
    });
    worker.once('error', () => finish({ error: new AuditManualReviewError('OTHER_UNVERIFIED', 'Automatic HTML inspection stopped unexpectedly; quality remains unverified.') }));
    worker.once('exit', code => { if (!settled) finish({ error: new AuditManualReviewError('OTHER_UNVERIFIED', code === 0 ? 'Automatic HTML inspection ended without a result; quality remains unverified.' : 'Automatic HTML inspection stopped unexpectedly; quality remains unverified.') }); });
  });
}
if (!isMainThread && workerData?.htmlAudit === true) {
  parentPort!.once('message', () => {
    try { parentPort!.postMessage({ checks: inspectHtml(workerData.result as WebsiteFetchResult, workerData.config as ScoringConfig) }); }
    catch (error) {
      if (error instanceof AuditManualReviewError) parentPort!.postMessage({ failure: { reason: error.reason, message: error.message, detail: error.detail } });
      else parentPort!.postMessage({ failure: { reason: 'OTHER_UNVERIFIED', message: 'Automatic HTML inspection stopped unexpectedly; quality remains unverified.', detail: null } });
    }
  });
  parentPort!.postMessage({ ready: true });
}
