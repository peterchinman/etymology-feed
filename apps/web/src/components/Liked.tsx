import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { getSwipes, type LocalSwipe, removeSwipe } from '../lib/local';

export default function Liked() {
  const [swipes, setSwipes] = createSignal<LocalSwipe[]>([]);
  const [query, setQuery] = createSignal('');
  const [open, setOpen] = createSignal<string | null>(null);
  const [online, setOnline] = createSignal(true);
  const [banner, setBanner] = createSignal(true);
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal('');
  let touch: { id: string; x: number; y: number } | null = null;
  const liked = createMemo(() =>
    swipes().filter((swipe) => swipe.verdict === 1),
  );
  const visible = createMemo(() =>
    liked().filter((swipe) => {
      const text =
        `${swipe.word} ${swipe.card.etymology} ${swipe.card.definition}`.toLowerCase();
      return text.includes(query().trim().toLowerCase());
    }),
  );

  async function remove(id: string) {
    try {
      await removeSwipe(id);
      setSwipes((current) => current.filter((swipe) => swipe.id !== id));
    } catch {
      setError('Could not remove this word. Please try again.');
    }
  }

  async function copyAll() {
    const text = liked()
      .map((swipe) => `${swipe.word} — ${swipe.card.etymology}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Clipboard access is unavailable.');
    }
  }

  onMount(() => {
    setOnline(navigator.onLine);
    setBanner(
      sessionStorage.getItem('etymology-anon-banner-dismissed') !== '1',
    );
    void getSwipes()
      .then(setSwipes)
      .catch(() => setError('Could not open your saved words.'));
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    onCleanup(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });
  });

  return (
    <section class="liked-page page-wrap">
      <h1 class="sr-only">Liked</h1>
      <Show when={banner()}>
        <aside class="anon-banner body-voice">
          <div>
            <strong>You're not signed in.</strong> Your list is saved only on
            this device.
          </div>
          <div class="banner-actions">
            <button
              type="button"
              class="banner-signin instructive-voice"
              disabled
              title="Sign-in arrives in a later milestone"
            >
              Sign in
            </button>
            <button
              type="button"
              class="banner-dismiss instructive-voice"
              aria-label="Dismiss sign-in reminder"
              onClick={() => {
                sessionStorage.setItem('etymology-anon-banner-dismissed', '1');
                setBanner(false);
              }}
            >
              ×
            </button>
          </div>
        </aside>
      </Show>
      <Show when={!online()}>
        <p class="offline-note instructive-voice" role="status">
          Offline · {swipes().filter((swipe) => !swipe.synced).length} swipes
          waiting to sync
        </p>
      </Show>
      <div class="liked-tools">
        <label class="search-field">
          <span class="sr-only">Search liked words</span>
          <span aria-hidden="true">⌕</span>
          <input
            class="body-voice"
            type="search"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search your words"
          />
        </label>
        <button
          type="button"
          class="copy-button instructive-voice"
          disabled={!liked().length}
          onClick={() => void copyAll()}
        >
          {copied() ? 'Copied!' : 'Copy all'}
        </button>
      </div>
      <Show
        when={visible().length}
        fallback={
          <div class="liked-empty">
            <span aria-hidden="true">♡</span>
            <h2 class="loud-voice">
              {query() ? 'No matching words.' : 'Your list begins here.'}
            </h2>
            <p class="body-voice">
              {query()
                ? 'Try another search.'
                : 'Swipe right on a word that stays with you.'}
            </p>
            <a class="instructive-voice" href="/">
              Explore the feed →
            </a>
          </div>
        }
      >
        <div class="liked-list">
          <For each={visible()}>
            {(swipe) => (
              <article
                class="liked-item"
                onPointerDown={(event) => {
                  if (event.pointerType === 'touch')
                    touch = {
                      id: swipe.id,
                      x: event.clientX,
                      y: event.clientY,
                    };
                }}
                onPointerUp={(event) => {
                  if (!touch || touch.id !== swipe.id) return;
                  const dx = event.clientX - touch.x;
                  const dy = event.clientY - touch.y;
                  touch = null;
                  if (dx < -80 && Math.abs(dx) > Math.abs(dy))
                    void remove(swipe.id);
                }}
              >
                <div class="liked-item-main">
                  <div>
                    <h2 class="loud-voice">{swipe.word}</h2>
                  </div>
                  <button
                    type="button"
                    class="remove-button instructive-voice"
                    aria-label={`Remove ${swipe.word} from Liked`}
                    onClick={() => void remove(swipe.id)}
                  >
                    ×
                  </button>
                </div>
                <p class="liked-etymology story-voice">
                  {swipe.card.etymology}
                </p>
                <button
                  type="button"
                  class="definition-toggle instructive-voice"
                  aria-expanded={open() === swipe.id}
                  onClick={() => setOpen(open() === swipe.id ? null : swipe.id)}
                >
                  {open() === swipe.id
                    ? 'Hide definition −'
                    : 'Show definition +'}
                </button>
                <Show when={open() === swipe.id}>
                  <div class="definition">
                    <span class="definition-label instructive-voice">
                      {swipe.card.pos.join(' · ') || swipe.card.defPos}
                    </span>
                    <p class="story-voice">{swipe.card.definition}</p>
                  </div>
                </Show>
                <a
                  class="source-line quiet-voice"
                  href={`https://en.wiktionary.org/wiki/${encodeURIComponent(swipe.word)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Wiktionary · CC BY-SA ↗
                </a>
              </article>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <p class="inline-error instructive-voice" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
