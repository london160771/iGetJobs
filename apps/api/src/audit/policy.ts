import type { AuditCheck, Lead, LeadClassification, ScoreReason, ScoringConfig } from '@igetjobs/shared';
export const defaultScoring: ScoringConfig = {
  weights: { no_website: 60, unreachable: 50, https: 10, viewport: 8, mobile_width: 6, performance: 5, page_size: 4, contact: 6, cta: 6, structure: 4, links: 3, contactable: 10, business_signal: 5, source_identity: 5 },
  poorThreshold: 18, highPriority: 70, mediumPriority: 40, slowMs: 3000, largeBytes: 500000
};
export function readScoring(env: NodeJS.ProcessEnv): ScoringConfig {
  if (!env.AUDIT_SCORING_JSON?.trim()) return structuredClone(defaultScoring);
  try {
    const input = JSON.parse(env.AUDIT_SCORING_JSON) as ScoringConfig;
    const expected = Object.keys(defaultScoring.weights).sort();
    if (!input || typeof input !== 'object' || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(Object.keys(defaultScoring).sort())
      || !input.weights || JSON.stringify(Object.keys(input.weights).sort()) !== JSON.stringify(expected)
      || Object.values(input.weights).some(value => !Number.isInteger(value) || value < 0 || value > 100)
      || ![input.poorThreshold, input.highPriority, input.mediumPriority, input.slowMs, input.largeBytes].every(value => Number.isInteger(value) && value > 0)
      || input.poorThreshold > 100 || input.highPriority > 100 || input.mediumPriority >= input.highPriority || input.slowMs > 20000 || input.largeBytes > 1048576) throw new Error();
    return structuredClone(input);
  } catch { throw new Error('AUDIT_SCORING_JSON must contain the documented weights and valid numeric thresholds.'); }
}
export function evaluateLead(lead: Lead, checks: AuditCheck[], config: ScoringConfig): { classification: LeadClassification; classificationReasons: string[]; score: number; scoreReasons: ScoreReason[] } {
  const failed = checks.filter(check => check.outcome === 'fail');
  const missing = failed.some(check => check.key === 'website_present');
  const unreachable = failed.some(check => check.key === 'reachable');
  const quality = failed.filter(check => config.weights[check.key] !== undefined && !['website_present', 'reachable'].includes(check.key));
  const qualityPoints = quality.reduce((sum, check) => sum + config.weights[check.key]!, 0);
  const classification: LeadClassification = missing ? 'NO_WEBSITE' : unreachable || qualityPoints >= config.poorThreshold ? 'POOR_WEBSITE' : 'ACCEPTABLE_WEBSITE';
  const classificationReasons = missing ? ['No website URL is available after checking canonical and linked source evidence.'] : unreachable
    ? ['The selected website could not be reached by this audit; page quality checks are unknown.']
    : [`Measured quality penalties: ${qualityPoints}; poor-website threshold: ${config.poorThreshold}.`, ...quality.map(check => check.label + ': ' + check.evidence)];
  const scoreReasons: ScoreReason[] = [];
  function add(key: string, label: string, evidence: string) {
    const points = config.weights[key]!;
    if (points > 0) scoreReasons.push({ key, label, points, evidence });
  }
  if (missing) add('no_website', 'No website found in available evidence', failed.find(check => check.key === 'website_present')!.evidence!);
  if (unreachable) add('unreachable', 'Website unreachable in this audit', failed.find(check => check.key === 'reachable')!.evidence!);
  for (const check of quality) add(check.key, check.label, check.evidence || 'Measured check failed.');
  if (lead.email || lead.phone) add('contactable', 'Contact information available', [lead.email ? 'Email present' : '', lead.phone ? 'Validated phone present' : ''].filter(Boolean).join('; '));
  if (lead.rating !== null && lead.rating >= 4 && lead.reviewCount !== null && lead.reviewCount >= 5) add('business_signal', 'Recorded rating/review signal', `Source rating ${lead.rating}/5 from ${lead.reviewCount} reviews; not independently verified.`);
  if (lead.provenance.some(item => item.sourceId)) add('source_identity', 'Traceable source record', 'At least one preserved source identifier.');
  const total = scoreReasons.reduce((sum, reason) => sum + reason.points, 0);
  if (total > 100) scoreReasons.push({ key: 'score_cap', label: 'Score capped at 100', points: 100 - total, evidence: `Uncapped total ${total}; maximum 100.` });
  if (scoreReasons.length === 0) scoreReasons.push({ key: 'no_factors', label: 'No measured opportunity factors', points: 0, evidence: 'No failed weighted checks or recorded contact/rating/source factors contributed points.' });
  return { classification, classificationReasons, score: Math.min(100, total), scoreReasons };
}
