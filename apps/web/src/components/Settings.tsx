import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  applyTheme,
  type ColorMode,
  getSettings,
  setColorMode,
  setShowDefinitions,
  setTheme,
} from '../lib/local';
import { DEFAULT_THEME, THEMES, type Theme } from '../lib/themes';

type Props = {
  /** A floating panel over the feed (desktop) or a page of its own (mobile). */
  variant: 'panel' | 'page';
  /** Close the panel; the page variant has no close button. */
  onClose?: () => void;
  /** Tell the feed underneath that the definition default changed. */
  onShowDefinitions?: (value: boolean) => void;
};

export default function Settings(props: Props) {
  const [showDefinitions, setShowDefinitionsState] = createSignal(false);
  const [theme, setThemeState] = createSignal<Theme>(DEFAULT_THEME);
  const [colorMode, setColorModeState] = createSignal<ColorMode>('system');
  const [dark, setDark] = createSignal(false);
  const [error, setError] = createSignal('');

  async function changeDefinitionSetting(value: boolean) {
    try {
      await setShowDefinitions(value);
      setShowDefinitionsState(value);
      props.onShowDefinitions?.(value);
    } catch {
      setError('Could not save the definition setting.');
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

  async function changeColorMode(value: Exclude<ColorMode, 'system'>) {
    try {
      await setColorMode(value);
      setColorModeState(value);
      setDark(value === 'dark');
    } catch {
      setError('Could not save the dark mode setting.');
    }
  }

  onMount(() => {
    void getSettings()
      .then((settings) => {
        setShowDefinitionsState(settings.showDefinitions);
        setThemeState(settings.theme);
        setColorModeState(settings.colorMode);
        setDark(applyTheme(settings.theme, settings.colorMode));
      })
      .catch(() =>
        setError(
          'Local storage is unavailable. Enable site storage to keep your settings.',
        ),
      );
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (colorMode() === 'system') setDark(systemDark.matches);
    };
    systemDark.addEventListener('change', onSystemThemeChange);
    onCleanup(() =>
      systemDark.removeEventListener('change', onSystemThemeChange),
    );
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
      <label class="setting-row label-voice">
        <span>Always show definitions</span>
        <input
          type="checkbox"
          checked={showDefinitions()}
          onChange={(event) => {
            void changeDefinitionSetting(event.currentTarget.checked);
          }}
        />
      </label>
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
        <p class="theme-blurb caption-voice">
          {THEMES.find((option) => option.id === theme())?.blurb}
        </p>
      </div>
      <label class="setting-row label-voice">
        <span>Dark mode</span>
        <input
          class="theme-switch"
          type="checkbox"
          checked={dark()}
          onChange={(event) => {
            void changeColorMode(
              event.currentTarget.checked ? 'dark' : 'light',
            );
          }}
        />
        <span class="switch-track" aria-hidden="true" />
      </label>
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
