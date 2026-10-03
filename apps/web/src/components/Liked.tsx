import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import {
  getAccount,
  reconcileAccountLikes,
  refreshLikeCounts,
} from '../lib/account';
import { likedTotal } from '../lib/likes';
import { getSwipes, type LocalSwipe, removeSwipe } from '../lib/local';
import { drainSync } from '../lib/sync';
import CardFooter from './CardFooter';
import ExpandableText from './ExpandableText';

function LikedCard(props: { swipe: LocalSwipe; onRemove: () => void }) {
  let touch: { x: number; y: number } | null = null;
  const swipe = props.swipe;
  return (
    <article
      class="liked-item"
      onPointerDown={(event) => {
        if (event.pointerType === 'touch')
          touch = { x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => {
        touch = null;
      }}
      onPointerUp={(event) => {
        if (!touch) return;
        const dx = event.clientX - touch.x;
        const dy = event.clientY - touch.y;
        touch = null;
        if (dx < -80 && Math.abs(dx) > Math.abs(dy)) props.onRemove();
      }}
    >
      <div class="liked-item-main word-head">
        <h2 class="display-voice">{swipe.word}</h2>
        <button
          type="button"
          class="remove-button"
          aria-label={`Remove ${swipe.word} from Liked`}
          onClick={props.onRemove}
        >
          ×
        </button>
      </div>
      <div class="definition">
        <span class="definition-label label-voice">{swipe.card.defPos}</span>
        <ExpandableText
          text={swipe.card.definition}
          id={`liked-definition-${swipe.id}`}
          label="definition"
          className="liked-definition"
        />
      </div>
      <ExpandableText
        text={swipe.card.etymology}
        id={`liked-etymology-${swipe.id}`}
        label="etymology"
        className="liked-etymology"
      />
      <CardFooter
        word={swipe.word}
        etymNo={swipe.card.etymNo}
        likeCount={likedTotal(swipe)}
      />
    </article>
  );
}

export default function Liked() {
  const [swipes, setSwipes] = createSignal<LocalSwipe[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [online, setOnline] = createSignal(true);
  const [accountLoaded, setAccountLoaded] = createSignal(false);
  const [registered, setRegistered] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal('');
  const liked = createMemo(() =>
    swipes().filter((swipe) => swipe.verdict === 1 && !swipe.removed),
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
      void drainSync();
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

  // Guests: sync first so the refreshed totals include their own likes.
  async function refreshGuestTotals() {
    await drainSync();
    if (!navigator.onLine) return;
    try {
      setSwipes(await refreshLikeCounts());
    } catch {
      // Keep the stored totals; the next visit or reconnection retries.
    }
  }

  onMount(() => {
    setOnline(navigator.onLine);
    void getSwipes()
      .then((saved) => {
        setSwipes(saved);
        setLoaded(true);
      })
      .catch(() => {
        setError('Could not open your saved words.');
        setLoaded(true);
      });
    void getAccount()
      .then(async (account) => {
        setRegistered(!account.user.isAnonymous);
        setAccountLoaded(true);
        if (!account.user.isAnonymous && navigator.onLine)
          setSwipes(await reconcileAccountLikes());
        else void refreshGuestTotals();
      })
      .catch(() => {
        if (navigator.onLine) setError('Could not refresh saved words.');
      });
    const onOnline = () => {
      setOnline(true);
      if (registered())
        void reconcileAccountLikes()
          .then(setSwipes)
          .catch(() => {
            setError('Could not refresh saved words.');
          });
      else void refreshGuestTotals();
    };
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
      <Show when={accountLoaded() && !registered()}>
        <aside class="anon-banner">
          <div>
            <strong>You're not signed in.</strong> Your likes stay on this
            device.
          </div>
          <a class="banner-signin label-voice" href="/settings/#account">
            Sign in
          </a>
        </aside>
      </Show>
      <Show when={!online()}>
        <p class="offline-note body-voice" role="status">
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
          class="copy-button label-voice"
          disabled={!liked().length}
          onClick={() => void copyAll()}
        >
          {copied() ? 'Copied!' : 'Copy all'}
        </button>
      </div>
      <Show
        when={visible().length}
        fallback={
          <Show when={loaded()}>
            <div class="liked-empty">
              <svg class="heart-icon" aria-hidden="true" viewBox="0 0 256 256">
                <rect width="256" height="256" fill="none" />
                <path
                  d="M128,224l89.36-90.64a50,50,0,1,0-70.72-70.72L128,80,109.36,62.64a50,50,0,0,0-70.72,70.72Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="16"
                />
              </svg>
              <h2 class="display-voice">
                {query() ? 'No matching words.' : 'No liked words yet.'}
              </h2>
            </div>
          </Show>
        }
      >
        <div class="liked-list">
          <For each={visible()}>
            {(swipe) => (
              <LikedCard swipe={swipe} onRemove={() => void remove(swipe.id)} />
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <p class="inline-error body-voice" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
