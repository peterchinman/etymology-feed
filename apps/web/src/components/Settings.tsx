import { createSignal, For, onMount, Show } from 'solid-js';
import {
  applyTheme,
  type ColorMode,
  getSettings,
  setColorMode,
  setIncludeProperNouns,
  setTheme,
} from '../lib/local';
import { DEFAULT_THEME, THEMES, type Theme } from '../lib/themes';
import AccountControls from './AccountControls';

type Props = {
  /** A floating panel over the feed (desktop) or a page of its own (mobile). */
  variant: 'panel' | 'page';
  /** Close the panel; the page variant has no close button. */
  onClose?: () => void;
};

const COLOR_MODES: { id: ColorMode; name: string }[] = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'system', name: 'System' },
];

function themeOnPage(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  return (
    THEMES.find((option) =>
      document.documentElement.classList.contains(option.id),
    )?.id ?? DEFAULT_THEME
  );
}

function colorModeOnPage(): ColorMode {
  if (typeof document === 'undefined') return 'system';
  const mode = document.documentElement.dataset.colorMode;
  return mode === 'light' || mode === 'dark' ? mode : 'system';
}

export default function Settings(props: Props) {
  const [theme, setThemeState] = createSignal<Theme>(themeOnPage());
  const [colorMode, setColorModeState] = createSignal<ColorMode>(
    colorModeOnPage(),
  );
  const [error, setError] = createSignal('');
  const [includeProperNouns, setProperNounsState] = createSignal(false);
  const [savingFeed, setSavingFeed] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);

  async function changeProperNouns(value: boolean) {
    setSavingFeed(true);
    try {
      await setIncludeProperNouns(value);
      setProperNounsState(value);
      setError('');
    } catch {
      setError('Could not save the proper nouns setting.');
    } finally {
      setSavingFeed(false);
    }
  }

  async function changeTheme(value: Theme) {
    try {
      await setTheme(value);
      setThemeState(value);
    } catch {
      setError('Could not save the theme setting.');
    }
  }

  async function changeColorMode(value: ColorMode) {
    try {
      await setColorMode(value);
      setColorModeState(value);
    } catch {
      setError('Could not save the color mode setting.');
    }
  }

  onMount(() => {
    void getSettings()
      .then((settings) => {
        setThemeState(settings.theme);
        setColorModeState(settings.colorMode);
        setProperNounsState(settings.includeProperNouns);
        setLoaded(true);
        applyTheme(settings.theme, settings.colorMode);
      })
      .catch(() => {
        setError(
          'Local storage is unavailable. Enable site storage to keep your settings.',
        );
      });
  });

  return (
    <section
      class={`settings-panel${props.variant === 'page' ? ' settings-page' : ''}`}
      id={props.variant === 'panel' ? 'feed-settings' : undefined}
      aria-label={props.variant === 'panel' ? 'Settings' : undefined}
    >
      <div class="settings-panel-heading">
        <Show
          when={props.variant === 'panel'}
          fallback={<h1 class="display-voice">Settings</h1>}
        >
          <strong class="display-voice">Settings</strong>
          <button
            type="button"
            aria-label="Close settings"
            onClick={() => props.onClose?.()}
          >
            ×
          </button>
        </Show>
      </div>
      <div>
        <div
          class="setting-group"
          role="radiogroup"
          aria-labelledby="theme-label"
        >
          <span id="theme-label" class="label-voice">
            Theme
          </span>
          <div class="segmented">
            <For each={THEMES}>
              {(option) => (
                <label class="segment label-voice">
                  <input
                    type="radio"
                    name="theme"
                    value={option.id}
                    checked={theme() === option.id}
                    onChange={() => void changeTheme(option.id)}
                  />
                  <span>{option.name}</span>
                </label>
              )}
            </For>
          </div>
        </div>
        <div
          class="setting-group"
          role="radiogroup"
          aria-labelledby="color-mode-label"
        >
          <span id="color-mode-label" class="label-voice">
            Color mode
          </span>
          <div class="segmented">
            <For each={COLOR_MODES}>
              {(option) => (
                <label class="segment label-voice">
                  <input
                    type="radio"
                    name="color-mode"
                    value={option.id}
                    checked={colorMode() === option.id}
                    onChange={() => void changeColorMode(option.id)}
                  />
                  <span>{option.name}</span>
                </label>
              )}
            </For>
          </div>
        </div>
      </div>
      <div class="setting-group">
        <label class="setting-toggle label-voice">
          <span>Include proper nouns</span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={includeProperNouns()}
            checked={includeProperNouns()}
            disabled={!loaded() || savingFeed()}
            onChange={(event) =>
              void changeProperNouns(event.currentTarget.checked)
            }
          />
        </label>
        <p class="caption-voice">
          Show names of people, places, and other named things in your feed.
        </p>
      </div>
      <AccountControls variant="settings" />
      <p class="source-credit caption-voice">
        Etymologies and definitions are adapted from{' '}
        <a
          href="https://en.wiktionary.org/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Wiktionary contributors
        </a>
        , via{' '}
        <a href="https://kaikki.org/" target="_blank" rel="noopener noreferrer">
          kaikki.org
        </a>
        , under{' '}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noopener noreferrer"
        >
          CC BY-SA 4.0
        </a>
        . Select a word to open its original entry.
      </p>
      <Show when={error()}>
        <p class="inline-error body-voice" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
