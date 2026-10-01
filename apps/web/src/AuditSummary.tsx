import { leadPriority, type Lead } from '@igetjobs/shared';
export function AuditSummary({ lead, detailed = false }: { lead: Lead; detailed?: boolean }) {
  if (!lead.audit || lead.score === null || !lead.classification) return <p className="muted">Not audited. No classification or score yet.</p>;
  const priority = leadPriority(lead.score, lead.audit.scoring);
  return <div className="audit-summary">
    <div className="lead-title"><span className={`tag classification-${lead.classification.toLowerCase()}`}>{lead.classification.replace(/_/g, ' ')}</span><strong className="numeric-score">{lead.score}<span>/100</span></strong><span className="tag">{priority} priority</span></div>
    <p className="muted">{lead.audit.state === 'unreachable' ? 'Website unreachable in this audit. Page quality remains unknown.' : lead.audit.state === 'missing' ? 'No website found after checking available source evidence.' : 'Static HTML audit completed.'}</p>
    <ul className="score-reasons">{lead.scoreReasons.map(reason => <li key={reason.key}><strong>{reason.points > 0 ? '+' : ''}{reason.points}</strong> {reason.label}{detailed && <p className="muted">{reason.evidence}</p>}</li>)}</ul>
    {lead.scoreReasons.length === 0 && <p className="muted">No measured scoring factors apply.</p>}
    {!detailed && <details className="preview-warnings"><summary>Audit evidence</summary>{lead.audit.classificationReasons?.map(reason => <p key={reason}>{reason}</p>)}<ul>{lead.audit.checks.map(check => <li key={check.key}>{check.label}: {check.outcome}. {check.evidence}</li>)}</ul>{lead.scoreReasons.map(reason => <p key={reason.key}>{reason.label}: {reason.evidence}</p>)}</details>}
    {detailed && <>
      <div className="audit-explanation"><h2>Classification reasons</h2>{lead.audit.classificationReasons?.map(reason => <p key={reason}>{reason}</p>)}</div>
      <p className="muted">Audited {new Date(lead.audit.auditedAt).toLocaleString()} · {lead.audit.version}. Live pages and timings can change between audits.</p>
      <p>Selected website: {lead.audit.requestedWebsite || 'None in available evidence'}<br />{lead.audit.metrics?.status == null ? 'Attempted website' : 'Final response website'}: {lead.audit.website || 'None'}</p>
      <div className="audit-checks">{lead.audit.checks.map(check => <article key={check.key}><div className="lead-title"><h3>{check.label}</h3><span className={`tag check-${check.outcome}`}>{check.outcome}</span></div><p>{check.evidence || 'Not measured.'}</p></article>)}</div>
      {lead.audit.scoring && <details className="preview-warnings"><summary>Scoring weights and thresholds used</summary><p>Score sums measured reasons and caps at 100. Poor classification threshold: {lead.audit.scoring.poorThreshold}. High priority: {lead.audit.scoring.highPriority}; medium: {lead.audit.scoring.mediumPriority}.</p><dl className="weight-list">{Object.entries(lead.audit.scoring.weights).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, ' ')}</dt><dd>{value}</dd></div>)}</dl></details>}
    </>}
  </div>;
}
