/**
 * The visual concepts. Each is a complete design: its own type, color,
 * spacing, stroke, radius, and shadow contract lives in
 * styles/themes/<id>.css and is selected by a class on <html>.
 */
export type Theme = 'gallery' | 'nocturne' | 'indigo';

export type ThemeOption = {
  id: Theme;
  name: string;
  /** One line of personality, shown under the picker in Settings. */
  blurb: string;
};

export const THEMES: readonly ThemeOption[] = [
  {
    id: 'gallery',
    name: 'Gallery',
    blurb: 'White on white. Soft light, Garamond, and a grotesque with hooks.',
  },
  {
    id: 'nocturne',
    name: 'Nocturne',
    blurb:
      'Words as light. Midnight glass, sky blue, and an italic that glows.',
  },
  {
    id: 'indigo',
    name: 'Indigo',
    blurb: 'The word as a diagram: a cyanotype sheet, registered and measured.',
  },
];

export const DEFAULT_THEME: Theme = 'gallery';

/**
 * Canvas color of every theme in each mode, for the browser chrome
 * (`theme-color`) before the stylesheet has loaded. Must match the
 * `--color-canvas` values in styles/themes/*.css.
 */
export const THEME_COLORS: Record<Theme, { light: string; dark: string }> = {
  gallery: { light: '#ffffff', dark: '#000000' },
  nocturne: { light: '#eceaf3', dark: '#0a0b14' },
  indigo: { light: '#f2f5f9', dark: '#0b2447' },
};

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme.id === value);
}
