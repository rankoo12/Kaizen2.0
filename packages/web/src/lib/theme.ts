export const THEMES = ['nebula', 'deep-space', 'solar-flare'] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'nebula';

export const THEME_STORAGE_KEY = 'kaizen:theme';

export const THEME_LABELS: Record<Theme, string> = {
  'nebula':      'Nebula',
  'deep-space':  'Deep Space',
  'solar-flare': 'Solar Flare',
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
