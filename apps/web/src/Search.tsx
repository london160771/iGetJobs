import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { DiscoveryConfig, DiscoveryPreview, SaveAction, SaveResult } from '@igetjobs/shared';
import { leadLabelMaxLength } from '@igetjobs/shared';
import { api } from './lib/api';
import { EmptyState, PageHeader } from './components';
import { initialPreviewChoices, selectedPreviewChoices } from './discovery-selection';

export function Search() {
  const [config, setConfig] = useState<DiscoveryConfig | null>(null);
  const [source, setSource] = useState('GEOAPIFY');
  const [country, setCountry] = useState('');
  const [niche, setNiche] = useState('');
  const [city, setCity] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DiscoveryPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, SaveAction | 'skip'>>({});
  const [results, setResults] = useState<Record<string, SaveResult['results'][number]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [configRevision, setConfigRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void api<DiscoveryConfig>('/api/discovery/config').then(value => {
      if (active) { setConfig(value); setCountry(value.markets[0]?.code || ''); setNiche(value.niches[0]?.id || ''); setError(null); }
    }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [configRevision]);
  async function collect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || busy) return;
    setBusy(true); setError(null); setNotice(null); setPreview(null); setResults({}); setChoices({});
    try {
      if (source === 'CSV' && (!file || file.size > config.csvMaxBytes)) throw new Error('Choose a UTF-8 CSV file, 40KB or smaller.');
      const payload = source === 'CSV' ? { csv: await file!.text(), filename: file!.name, country, city, niche } : { source, country, city, niche };
      const value = await api<DiscoveryPreview>('/api/discovery/' + (source === 'CSV' ? 'import' : 'search'), { method: 'POST', body: JSON.stringify(payload) });
      setPreview(value);
      setChoices(initialPreviewChoices(value));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Results could not be loaded.'); }
    finally { setBusy(false); }
  }
  const selected = selectedPreviewChoices(choices, results);
  async function save() {
    if (!preview || busy || !selected.length) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const value = await api<SaveResult>('/api/discovery/save', { method: 'POST', body: JSON.stringify({ previewId: preview.id, selections: selected.map(([id, action]) => ({ id, action })) }) });
      setResults(current => ({ ...current, ...Object.fromEntries(value.results.map(result => [result.rowId, result])) }));
      const saved = value.results.filter(result => result.status === 'saved').length;
      const linked = value.results.filter(result => result.status === 'linked').length;
      const failed = value.results.filter(result => result.status === 'failed').length;
      setNotice(`${saved} saved · ${linked} sources added${failed ? ` · ${failed} need attention` : ''}.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Results could not be saved.'); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeader title="Find your next opportunity" description="Discover local businesses, review the details, and save the ones worth a closer look." />
    {error && <p className="message error-message" role="alert">{error}</p>}
    {!config ? <div className="message" role="status">{error ? <button className="text-button" onClick={() => setConfigRevision(value => value + 1)}>Retry connection</button> : 'Loading discovery sources…'}</div> : <form className="search-form" onSubmit={event => void collect(event)}>
      <div className="search-fields">
        <label>Country<select value={country} onChange={event => setCountry(event.target.value)} disabled={busy}>{config.markets.map(market => <option key={market.code} value={market.code}>{market.label}</option>)}</select></label>
        <label>{source === 'CSV' ? 'Default city (optional)' : 'City'}<input value={city} onChange={event => setCity(event.target.value)} placeholder="City, state or region" maxLength={leadLabelMaxLength} required={source !== 'CSV'} minLength={source === 'CSV' ? undefined : 2} disabled={busy} /></label>
        <label>{source === 'CSV' ? 'Default niche' : 'Niche'}<select value={niche} onChange={event => setNiche(event.target.value)} disabled={busy}>{config.niches.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Source<select value={source} onChange={event => setSource(event.target.value)} disabled={busy}>{config.sources.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? '' : ' · unavailable'}</option>)}<option value="CSV">CSV import</option></select></label>
      </div>
      {source === 'CSV' && <div className="csv-input"><label>CSV file<input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => setFile(event.target.files?.[0] || null)} required /></label><p>UTF-8 · up to 40KB / 200 rows. Include businessName or name. Optional columns: address, phone, website, email, country, city, niche, rating, reviewCount. Country/city/niche defaults fill blank rows.</p><a className="text-button" href="/lead-import-template.csv" download>Download CSV template</a></div>}
      <div className="search-form-footer"><p>{source === 'CSV' ? 'Import creates a preview. Nothing is saved automatically.' : 'One bounded search at a time. Review city coverage and source relevance before saving.'}</p><button className="button" disabled={busy} type="submit">{busy ? 'Working…' : source === 'CSV' ? 'Preview CSV' : 'Find leads'}</button></div>
    </form>}
    {notice && <div className="message success-message" role="status">{notice} <Link to="/leads" className="text-button">View saved leads →</Link></div>}
    {busy && <p className="message" role="status">{preview ? 'Saving selected results…' : 'Collecting and checking results…'}</p>}
    {!preview && !busy && <EmptyState title="A focused search starts here"><p>Choose a city and niche, or import a CSV. Website auditing and scoring come after discovery.</p></EmptyState>}
    {preview && <section className="results-section" aria-labelledby="results-heading">
      <div className="results-heading"><div><h2 id="results-heading">{preview.rows.length} results to review</h2><p className="muted">{preview.cached ? 'Cached source results · ' : ''}All results start at Skip. Choose up to 50 to save. Preview lasts 30 minutes.</p></div><button className="button" type="button" disabled={busy || selected.length === 0 || selected.length > 50} onClick={() => void save()}>Save selected ({selected.length})</button></div>
      {selected.length > 50 && <p className="message error-message" role="alert">Select no more than 50 results at a time.</p>}
      {preview.warnings.length > 0 && <details className="preview-warnings"><summary>Source notes ({preview.warnings.length})</summary><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {preview.rows.length === 0 && <p className="message">No named businesses were found. Try another city or niche, or check the source notes.</p>}
      <div className="lead-results">{preview.rows.map(({ lead, duplicate, warnings, discoverySignal, contactable }) => {
        const result = results[lead.id]; const done = result?.status === 'saved' || result?.status === 'linked';
        return <article className="lead-result" key={lead.id}>
          <div className="lead-result-main"><div className="lead-title"><h3>{lead.businessName}</h3><span className="tag">{lead.source}</span><span className={`tag ${duplicate.kind !== 'new' ? 'review-tag' : ''}`}>{done ? result.status === 'linked' ? 'Source added' : 'Saved' : duplicate.kind === 'new' ? 'New result' : duplicate.canLink ? 'Already saved' : 'Review duplicate'}</span></div>
            <p className="muted">{[lead.niche, lead.city, lead.country].filter(Boolean).join(' · ')}</p>{lead.address && <p>{lead.address}</p>}
            <p className="discovery-quality"><strong>{discoverySignal === 'STRONG_DISCOVERY_SIGNAL' ? 'Strong discovery signal' : discoverySignal === 'NEEDS_CONTACT_ENRICHMENT' ? 'Needs contact enrichment' : discoverySignal === 'WEBSITE_EVIDENCE_REVIEW' ? 'Website evidence needs review' : 'Website found · audit after saving'}</strong>{discoverySignal === 'WEBSITE_PRESENT' && contactable ? <span> · Contactable</span> : null}</p>
            <div className="lead-contact">{lead.website ? <a href={lead.website} target="_blank" rel="noreferrer">{lead.domain} ↗</a> : discoverySignal === 'WEBSITE_EVIDENCE_REVIEW' ? <span className="muted">Review source website evidence</span> : <span className="muted">No website in source</span>}{lead.phone && <span>{lead.phone}</span>}{lead.email && <span>{lead.email}</span>}{Object.entries(lead.socials).map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer">{label} ↗</a>)}</div>
            {duplicate.kind !== 'new' && <div className="duplicate-note"><strong>{duplicate.kind === 'possible' ? 'Possible match — review before saving separately.' : 'Matching record — choose how to handle it.'}</strong><p>{duplicate.reasons.join(' · ')}</p>{duplicate.matches.map((match, index) => <p key={index}>Matches {match.businessName}{match.address ? ' · ' + match.address : ''}{match.city ? ' · ' + match.city : ''} ({match.persisted ? 'saved' : 'in this preview'}, {match.source})</p>)}</div>}
            {warnings.map((warning, index) => <p className="row-warning" key={index}>{warning}</p>)}{result?.status === 'failed' && <p className="form-error" role="alert">{result.error}</p>}
          </div><div className="lead-result-action"><label>Save choice<span className="sr-only"> for {lead.businessName}</span><select aria-label={`Save choice for ${lead.businessName}`} value={done ? 'skip' : choices[lead.id] || 'skip'} disabled={busy || done} onChange={event => setChoices(current => ({ ...current, [lead.id]: event.target.value as SaveAction | 'skip' }))}><option value="skip">{done ? 'Completed' : 'Skip'}</option>{duplicate.kind === 'new' && <option value="save">Save new lead</option>}{duplicate.canLink && <option value="link">Add source to saved lead</option>}{duplicate.kind !== 'new' && <option value="separate">Reviewed · save separately</option>}</select></label></div>
        </article>;
      })}</div><p className="source-attribution">{preview.attribution}{preview.attribution.includes('Geoapify') && <> <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Powered by Geoapify ↗</a></>}{preview.attribution.includes('OpenStreetMap') && <> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">License and attribution ↗</a></>}</p>
    </section>}
  </>;
}
