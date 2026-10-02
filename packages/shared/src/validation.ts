/** Shared canonical city/niche limit for discovery, CSV, management and filters. */
export const leadLabelMaxLength = 300;
export function normalizedLeadLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().normalize('NFKC').replace(/\p{Cc}/gu, ' ');
}
export function validLeadLabel(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const label = normalizedLeadLabel(value);
  return value.length <= leadLabelMaxLength && (label === null || label.length <= leadLabelMaxLength);
}
