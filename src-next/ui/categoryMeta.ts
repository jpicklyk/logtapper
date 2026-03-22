/** Display names for processor categories */
export const CATEGORY_LABELS: Record<string, string> = {
  network: 'Network & Connectivity',
  telephony: 'Telephony & Radio',
  stability: 'Stability & Crashes',
  memory: 'Memory & Resources',
  battery: 'Battery & Power',
  process: 'App Lifecycle',
  security: 'Security & Privacy',
};

/** Sort order for category display */
export const CATEGORY_ORDER: string[] = [
  'network', 'telephony', 'stability', 'memory',
  'battery', 'process', 'security',
];

/** Get display label for a category, falling back to title-cased slug */
export function getCategoryLabel(category: string | undefined | null): string {
  if (!category) return 'Uncategorized';
  return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}
