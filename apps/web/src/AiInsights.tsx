import { useEffect, useState } from 'react';
import type { Lead } from '@igetjobs/shared';
import { api } from './lib/api';

export function AiInsights({ lead, blocked, onBusy }: { lead: Lead; blocked: boolean; onBusy(value:boolean):void }) {
  const [configured,setConfigured] = useState(false), [busy,setBusy] = useState<'summary' | 'angle' | null>(null);
  const [summary,setSummary] = useState<string | null>(null), [angle,setAngle] = useState<string | null>(null);
  const [error,setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ configured:boolean }>('/api/ai/config',{ signal:controller.signal }).then(value => { if (!controller.signal.aborted) setConfigured(value.configured); }).catch(() => {});
    return () => controller.abort();
  },[]);
  async function generate(action: 'summary' | 'angle') {
    if (busy || blocked || !configured) return;
    setBusy(action); onBusy(true); setError(null);
    try {
      const value = await api<{ text:string }>('/api/ai/' + lead.id + '/' + action,{ method:'POST',body:JSON.stringify({ expectedUpdatedAt:lead.updatedAt }) });
      if (action === 'summary') setSummary(value.text); else setAngle(value.text);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'AI assist is unavailable. The assessment is unchanged.'); }
    finally { setBusy(null); onBusy(false); }
  }
  if (!lead.audit || lead.classification === null || lead.score === null) return null;
  return <section className="audit-panel ai-assist"><h2>Optional AI assist</h2><p className="muted">Generated wording only. The audit, classification and score above remain deterministic. Review every suggestion.</p>
    <div className="management-actions"><button className="text-button" disabled={blocked || Boolean(busy) || !configured} onClick={() => void generate('summary')}>{busy === 'summary' ? 'Generating…' : 'Generate AI summary'}</button>
      {lead.classification === 'POOR_WEBSITE' && <button className="text-button" disabled={blocked || Boolean(busy) || !configured} onClick={() => void generate('angle')}>{busy === 'angle' ? 'Suggesting…' : 'Suggest outreach angle'}</button>}</div>
    {!configured && <p>AI assist is disabled. All deterministic workflows remain available.</p>}
    {summary && <p role="status"><strong>AI-generated summary:</strong> {summary}</p>}
    {angle && <p role="status"><strong>AI-generated outreach angle:</strong> {angle}</p>}
    {error && <p className="message error-message" role="alert">{error}</p>}
  </section>;
}
