import type { Card } from '@etymology-feed/shared/card';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { getSwipes, saveSearchLike } from '../lib/local';
import { drainSync } from '../lib/sync';
import CardFooter from './CardFooter';
import ExpandableText from './ExpandableText';

export default function Search() {
  const [query, setQuery] = createSignal('');
  const [words, setWords] = createSignal<string[]>([]);
  const [cards, setCards] = createSignal<Card[]>([]);
  const [hasMore, setHasMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [searched, setSearched] = createSignal(false);
  const [error, setError] = createSignal('');
  const [saveError, setSaveError] = createSignal('');
  const [online, setOnline] = createSignal(true);
  const [liked, setLiked] = createSignal(new Set<string>());
  const [saving, setSaving] = createSignal(new Set<string>());
  const [likesReady, setLikesReady] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  function cancelRequest() {
    clearTimeout(timer);
    request?.abort();
  }

  async function loadWord(word: string) {
    cancelRequest();
    const controller = new AbortController();
    request = controller;
    setQuery(word);
    setWords([]);
    setHasMore(false);
    setCards([]);
    setLoading(true);
    setError('');
    setSaveError('');
    try {
      const response = await fetch(
        `/api/words/${encodeURIComponent(word)}/etymologies`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error('lookup');
      const result = (await response.json()) as { cards: Card[] };
      if (!controller.signal.aborted) setCards(result.cards);
    } catch {
      if (!controller.signal.aborted)
        setError(
          'Could not load this word. Check your connection and try again.',
        );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setSearched(true);
      }
    }
  }

  async function search(openExact = false) {
    cancelRequest();
    const text = query().trim().normalize('NFC');
    if (!text) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    request = controller;
    setLoading(true);
    setError('');
    setCards([]);
    try {
      const response = await fetch(
        `/api/search?${new URLSearchParams({ q: text })}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error('search');
      const result = (await response.json()) as {
        words: string[];
        hasMore: boolean;
      };
      if (controller.signal.aborted) return;
      setWords(result.words);
      setHasMore(result.hasMore);
      const exact = result.words.find(
        (word) => word.toLowerCase() === text.toLowerCase(),
      );
      if (openExact && exact) {
        await loadWord(exact);
        return;
      }
    } catch {
      if (!controller.signal.aborted)
        setError('Could not search. Check your connection and try again.');
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setSearched(true);
      }
    }
  }

  function changeQuery(value: string) {
    cancelRequest();
    setQuery(value);
    setWords([]);
    setCards([]);
    setHasMore(false);
    setSearched(false);
    setError('');
    setSaveError('');
    setLoading(!!value.trim() && online());
    if (value.trim() && online()) timer = setTimeout(() => void search(), 250);
  }

  async function like(card: Card) {
    if (liked().has(card.id) || saving().has(card.id)) return;
    setSaving((current) => new Set([...current, card.id]));
    setSaveError('');
    try {
      await saveSearchLike(card);
      setLiked((current) => new Set([...current, card.id]));
      void drainSync();
    } catch {
      setSaveError('Could not save this word. Please try again.');
    } finally {
      setSaving(
        (current) => new Set([...current].filter((id) => id !== card.id)),
      );
    }
  }

  onMount(() => {
    setOnline(navigator.onLine);
    void getSwipes()
      .then((swipes) => {
        const latest = new Map<string, (typeof swipes)[number]>();
        for (const swipe of swipes)
          if (!latest.has(swipe.cardId)) latest.set(swipe.cardId, swipe);
        setLiked(
          new Set(
            [...latest.values()]
              .filter((swipe) => swipe.verdict === 1 && !swipe.removed)
              .map((swipe) => swipe.cardId),
          ),
        );
        setLikesReady(true);
      })
      .catch(() =>
        setSaveError(
          'Local storage is unavailable. Could not open your saved words.',
        ),
      );
    const onOnline = () => {
      setOnline(true);
      void drainSync();
      if (query().trim() && !cards().length) void search();
    };
    const onOffline = () => {
      setOnline(false);
      cancelRequest();
      setLoading(false);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    onCleanup(() => {
      cancelRequest();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });
  });

  return (
    <section class="search-page page-wrap">
      <h1 class="display-voice search-heading">Search</h1>
      <p class="search-intro body-voice">Find the story behind a word.</p>
      <search>
        <form
          class="search-tools"
          onSubmit={(event) => {
            event.preventDefault();
            if (online()) void search(true);
          }}
        >
          <label class="search-field">
            <span class="sr-only">Search words</span>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <circle
                cx="10.5"
                cy="10.5"
                r="6.5"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <path
                d="m15.5 15.5 5 5"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            <input
              class="body-voice"
              type="search"
              enterkeyhint="search"
              autocomplete="off"
              spellcheck={false}
              maxLength={200}
              value={query()}
              onInput={(event) => changeQuery(event.currentTarget.value)}
              placeholder="Search for a word"
            />
          </label>
          <button
            class="primary-button label-voice"
            type="submit"
            disabled={!query().trim() || !online()}
          >
            Search
          </button>
        </form>
      </search>
      <Show when={!online()}>
        <p class="offline-note body-voice" role="status">
          Connect to the internet to search. You can still save words already
          open here.
        </p>
      </Show>
      <div class="search-status body-voice" role="status" aria-live="polite">
        <Show when={loading()}>Searching…</Show>
        <Show when={!loading() && searched() && !error() && online()}>
          {cards().length
            ? `${cards().length} ${cards().length === 1 ? 'origin' : 'origins'} found.`
            : words().length
              ? 'Choose a word to explore its origins.'
              : 'No matching words. Try another spelling.'}
        </Show>
      </div>
      <Show when={words().length}>
        <ul class="search-suggestions" aria-label="Matching words">
          <For each={words()}>
            {(word) => (
              <li>
                <button
                  type="button"
                  class="search-suggestion body-voice"
                  disabled={!online()}
                  onClick={() => void loadWord(word)}
                >
                  {word}
                  <span aria-hidden="true">→</span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={hasMore()}>
          <p class="search-intro body-voice">
            Keep typing to narrow the results.
          </p>
        </Show>
      </Show>
      <div class="liked-list search-results" aria-busy={loading()}>
        <For each={cards()}>
          {(card) => (
            <article class="liked-item">
              <div class="liked-item-main word-head">
                <h2 class="display-voice">{card.word}</h2>
              </div>
              <Show when={card.etymNo}>
                <p class="label-voice search-origin">Origin {card.etymNo}</p>
              </Show>
              <div class="definition">
                <span class="definition-label label-voice">{card.defPos}</span>
                <ExpandableText
                  text={card.definition}
                  id={`search-definition-${card.id}`}
                  label="definition"
                  className="liked-definition"
                />
              </div>
              <ExpandableText
                text={card.etymology}
                id={`search-etymology-${card.id}`}
                label="etymology"
                className="liked-etymology"
              />
              <button
                type="button"
                class="search-save label-voice"
                disabled={
                  !likesReady() || liked().has(card.id) || saving().has(card.id)
                }
                aria-label={`${liked().has(card.id) ? 'Saved' : 'Save'} ${card.word}${card.etymNo ? ` origin ${card.etymNo}` : ''} to Liked`}
                onClick={() => void like(card)}
              >
                {liked().has(card.id)
                  ? 'Saved to Liked'
                  : saving().has(card.id)
                    ? 'Saving…'
                    : 'Save to Liked'}
              </button>
              <CardFooter
                word={card.word}
                etymNo={card.etymNo}
                likeCount={card.likeCount}
              />
            </article>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="inline-error body-voice" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={saveError()}>
        <p class="inline-error body-voice" role="alert">
          {saveError()}
        </p>
      </Show>
    </section>
  );
}
