import type { DiscoveryPreview, SaveAction } from '@igetjobs/shared';

export type PreviewChoices = Record<string, SaveAction | 'skip'>;

export function initialPreviewChoices(preview: DiscoveryPreview): PreviewChoices {
  return Object.fromEntries(preview.rows.map(row => [row.lead.id, 'skip' as const]));
}

export function selectedPreviewChoices(choices: PreviewChoices, completed: Record<string, { status: string }>): [string, SaveAction][] {
  return Object.entries(choices).filter((entry): entry is [string, SaveAction] =>
    entry[1] !== 'skip' && completed[entry[0]]?.status !== 'saved' && completed[entry[0]]?.status !== 'linked');
}
