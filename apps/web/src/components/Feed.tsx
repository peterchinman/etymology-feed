import type { Card } from '@etymology-feed/shared/card';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { fetchCards } from '../lib/api';
import {
  appendCards,
  getSettings,
  getStack,
  type LocalSwipe,
  saveSwipe,
  setShowDefinitions,
  setTheme,
  type Theme,
  undoSwipe,
} from '../lib/local';

export default function Feed() {
  const [stack, setStack] = createSignal<Card[]>([]);
  const [ready, setReady] = createSignal(false);
  const [online, setOnline] = createSignal(true);
  const [fetching, setFetching] = createSignal(false);
  const [error, setError] = createSignal('');
  const [showDefinitions, setShowDefinitionsState] = createSignal(false);
  const [definitionOpen, setDefinitionOpen] = createSignal(false);
  const [theme, setThemeState] = createSignal<Theme>('system');
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [dragX, setDragX] = createSignal(0);
  const [leaving, setLeaving] = createSignal<'left' | 'right' | null>(null);
  const [pendingUndo, setPendingUndo] = createSignal<LocalSwipe | null>(null);
  let shownAt = Date.now();
  let filling = false;
  let committing = false;
  let exhaustedUntil = 0;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let gesture: {
    x: number;
    y: number;
    time: number;
    active: boolean;
    cancelled: boolean;
  } | null = null;

  async function fillStack(force = false) {
    if (filling || !navigator.onLine || Date.now() < exhaustedUntil) return;
    if (!force && stack().length >= 60) return;
    filling = true;
    setFetching(true);
    let misses = 0;
    try {
      // The read-only M1 API can send previously seen words; the local served set filters them.
      for (
        let attempt = 0;
        attempt < 6 && navigator.onLine && stack().length < 150;
        attempt++
      ) {
        const cards = await fetchCards();
        const before = stack().length;
        const next = await appendCards(cards);
        setStack([...next]);
        if (next.length === before) misses++;
        else misses = 0;
        if (misses >= 2) {
          exhaustedUntil = Date.now() + 5 * 60_000;
          break;
        }
      }
      setError('');
    } catch {
      setError('Could not load more words. Your saved cards are still here.');
    } finally {
      filling = false;
      setFetching(false);
    }
  }

  async function commit(verdict: 1 | -1) {
    const card = stack()[0];
    if (!card || committing) return;
    committing = true;
    setLeaving(verdict === 1 ? 'right' : 'left');
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (!reduced) await new Promise((resolve) => setTimeout(resolve, 170));
    try {
      const swipe = await saveSwipe(card, verdict, shownAt);
      if (undoTimer) clearTimeout(undoTimer);
      setPendingUndo(swipe);
      undoTimer = setTimeout(() => setPendingUndo(null), 5000);
      setStack((current) => current.slice(1));
      shownAt = Date.now();
      setDefinitionOpen(showDefinitions());
      if (stack().length < 60) void fillStack();
    } catch {
      setError('The swipe could not be saved. Please try again.');
    } finally {
      setDragX(0);
      setLeaving(null);
      committing = false;
    }
  }

  async function undo() {
    const swipe = pendingUndo();
    if (!swipe || committing) return;
    if (undoTimer) clearTimeout(undoTimer);
    setPendingUndo(null);
    try {
      setStack([...(await undoSwipe(swipe))]);
      shownAt = Date.now();
      setDefinitionOpen(showDefinitions());
    } catch {
      setError('Undo failed. The swipe is still saved locally.');
    }
  }

  async function changeDefinitionSetting(value: boolean) {
    try {
      await setShowDefinitions(value);
      setShowDefinitionsState(value);
      setDefinitionOpen(value);
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

  function pointerDown(event: PointerEvent) {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button, a')
    )
      return;
    gesture = {
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      active: false,
      cancelled: false,
    };
  }

  function pointerMove(event: PointerEvent) {
    if (!gesture || gesture.cancelled) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        gesture.cancelled = true;
        return;
      }
      if (Math.abs(dx) <= 10 || Math.abs(dx) <= Math.abs(dy)) return;
      gesture.active = true;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    setDragX(dx);
  }

  function pointerUp(event: PointerEvent) {
    if (!gesture) return;
    const { active, cancelled, x, time } = gesture;
    gesture = null;
    if (!active || cancelled) return;
    const dx = event.clientX - x;
    const width = (event.currentTarget as HTMLElement).clientWidth;
    const velocity = Math.abs(dx) / Math.max(1, performance.now() - time);
    if (Math.abs(dx) > width * 0.35 || (Math.abs(dx) > 10 && velocity > 0.5)) {
      void commit(dx > 0 ? 1 : -1);
    } else {
      setDragX(0);
    }
  }

  function keyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        'input, select, textarea, button, [contenteditable="true"]',
      ) ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      void commit(1);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void commit(-1);
    }
    if (event.key.toLowerCase() === 'd') setDefinitionOpen((value) => !value);
    if (event.key.toLowerCase() === 'z') void undo();
  }

  onMount(() => {
    setOnline(navigator.onLine);
    setSettingsOpen(
      new URLSearchParams(window.location.search).has('settings'),
    );
    void (async () => {
      try {
        const [cards, settings] = await Promise.all([
          getStack(),
          getSettings(),
        ]);
        setStack(cards);
        setShowDefinitionsState(settings.showDefinitions);
        setDefinitionOpen(settings.showDefinitions);
        setThemeState(settings.theme);
        setReady(true);
        void fillStack(true);
      } catch {
        setError(
          'Local storage is unavailable. Enable site storage to keep your words.',
        );
        setReady(true);
      }
    })();
    const onOnline = () => {
      setOnline(true);
      void fillStack(true);
    };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && stack().length < 60)
        void fillStack();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('keydown', keyDown);
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => {
      if (undoTimer) clearTimeout(undoTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('keydown', keyDown);
      document.removeEventListener('visibilitychange', onVisible);
    });
  });

  return (
    <section class="feed-page page-wrap">
      <h1 class="sr-only">Feed</h1>
      <Show when={settingsOpen()}>
        <section
          class="settings-panel"
          id="feed-settings"
          aria-label="Settings"
        >
          <div class="settings-panel-heading">
            <strong>Settings</strong>
            <button
              type="button"
              aria-label="Close settings"
              onClick={() => {
                setSettingsOpen(false);
                window.history.replaceState(null, '', '/');
              }}
            >
              ×
            </button>
          </div>
          <label class="setting-row">
            <span>Always show definitions</span>
            <input
              type="checkbox"
              checked={showDefinitions()}
              onChange={(event) => {
                void changeDefinitionSetting(event.currentTarget.checked);
              }}
            />
          </label>
          <label class="setting-row">
            <span>Theme</span>
            <select
              value={theme()}
              onChange={(event) => {
                void changeTheme(event.currentTarget.value as Theme);
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <a class="settings-about" href="/about/">
            About
          </a>
        </section>
      </Show>
      <div class="deck-area">
        <Show
          when={stack()[0]}
          fallback={
            <div class="word-card empty-card">
              <span class="card-kicker">THE NEXT WORD</span>
              <h2>
                {ready()
                  ? online()
                    ? fetching()
                      ? 'Finding words…'
                      : 'You’re all caught up.'
                    : 'Offline for now.'
                  : 'Opening your stack…'}
              </h2>
              <p>
                {online()
                  ? 'Your next story is on its way.'
                  : `Your saved stack is empty. Reconnect for more words; your swipes are safe on this device.`}
              </p>
              <Show when={online() && !fetching()}>
                <button
                  class="primary-button"
                  type="button"
                  onClick={() => void fillStack(true)}
                >
                  Try again
                </button>
              </Show>
            </div>
          }
        >
          {(card) => (
            <>
              <Show when={stack()[1]}>
                <div class="word-card card-peek" aria-hidden="true"></div>
              </Show>
              <article
                class={`word-card active-card ${leaving() ? `leaving-${leaving()}` : ''}`}
                data-testid="top-card"
                style={{
                  '--drag-x': `${dragX()}px`,
                  '--drag-rotate': `${dragX() / 20}deg`,
                }}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => {
                  gesture = null;
                  setDragX(0);
                }}
              >
                <div
                  class="swipe-cue cue-like"
                  style={{ opacity: Math.max(0, Math.min(1, dragX() / 100)) }}
                >
                  Interesting
                </div>
                <div
                  class="swipe-cue cue-skip"
                  style={{ opacity: Math.max(0, Math.min(1, -dragX() / 100)) }}
                >
                  Not for me
                </div>
                <div class="word-head">
                  <h2>{card().word}</h2>
                </div>
                <div class="card-body">
                  <p class="etymology">{card().etymology}</p>
                  <Show when={definitionOpen()}>
                    <div class="definition" id="definition">
                      <span class="definition-label">
                        {card().pos.join(' · ') || card().defPos}
                      </span>
                      <p>{card().definition}</p>
                    </div>
                  </Show>
                </div>
                <div class="card-bottom">
                  <button
                    class="definition-toggle"
                    type="button"
                    aria-expanded={definitionOpen()}
                    aria-controls="definition"
                    onClick={() => setDefinitionOpen((value) => !value)}
                  >
                    {definitionOpen() ? 'Hide definition' : 'Show definition'}{' '}
                    <span aria-hidden="true">
                      {definitionOpen() ? '−' : '+'}
                    </span>
                  </button>
                  <a
                    class="source-line"
                    href={`https://en.wiktionary.org/wiki/${encodeURIComponent(card().word)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Wiktionary · CC BY-SA ↗
                  </a>
                </div>
              </article>
            </>
          )}
        </Show>
      </div>
      <div
        class="deck-controls"
        data-testid="deck-controls"
        data-stack-count={stack().length}
      >
        <button
          class="swipe-button skip-button"
          type="button"
          disabled={!stack().length || !!leaving()}
          aria-label="Not for me"
          onClick={() => void commit(-1)}
        >
          <span aria-hidden="true">×</span>
        </button>
        <button
          class="swipe-button like-button"
          type="button"
          disabled={!stack().length || !!leaving()}
          aria-label="Interesting"
          onClick={() => void commit(1)}
        >
          <span aria-hidden="true">♡</span>
        </button>
      </div>
      <Show when={error()}>
        <p class="inline-error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
