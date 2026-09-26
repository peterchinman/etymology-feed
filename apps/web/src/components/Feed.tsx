import type { Card } from '@etymology-feed/shared/card';
import {
  batch,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { fetchCards } from '../lib/api';
import {
  appendCards,
  applyTheme,
  type ColorMode,
  getSettings,
  getStack,
  type LocalSwipe,
  type PendingSwipe,
  saveSwipes,
  setColorMode,
  setShowDefinitions,
  setTheme,
  undoSwipe,
} from '../lib/local';
import {
  clamp,
  commitDistance,
  type Direction,
  decide,
  planExit,
  releaseVelocity,
  rotation,
  type Sample,
  SWIPE,
  springEasing,
} from '../lib/swipe';
import { DEFAULT_THEME, THEMES, type Theme } from '../lib/themes';

/** A card that has been swiped and is still flying off-screen. */
type Departing = {
  card: Card;
  direction: Direction;
  definitionOpen: boolean;
  animation: Animation | null;
};

type Release = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grab: Direction;
};

type Gesture = {
  id: number;
  card: Card;
  width: number;
  grab: Direction;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  active: boolean;
  cancelled: boolean;
  samples: Sample[];
};

type Timing = { duration: number; easing: string };

/** Ease-out for cards moving into place: the next card rising, an undo returning. */
const SETTLE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const FALLBACK_SNAP: Timing = {
  duration: 340,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
};

let linearEasingSupport: boolean | undefined;
function supportsLinearEasing(): boolean {
  linearEasingSupport ??=
    typeof CSS !== 'undefined' &&
    CSS.supports('animation-timing-function', 'linear(0, 1)');
  return linearEasingSupport;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function currentTransform(element: Element): string {
  return getComputedStyle(element).transform;
}

/**
 * Animate an element from a captured transform to whatever its stylesheet says
 * now. The end keyframe is implicit, so if the target moves mid-flight (the
 * user grabs the card again) the animation bends toward the new target
 * instead of fighting it.
 */
function settle(
  element: HTMLElement,
  from: string,
  timing: Timing,
  id: string,
): Animation {
  for (const running of element.getAnimations()) running.cancel();
  const animation = element.animate([{ transform: from, offset: 0 }], timing);
  animation.id = id;
  return animation;
}

export default function Feed() {
  const [stack, setStack] = createSignal<Card[]>([]);
  const [departing, setDeparting] = createSignal<Departing[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [online, setOnline] = createSignal(true);
  const [fetching, setFetching] = createSignal(false);
  const [error, setError] = createSignal('');
  const [showDefinitions, setShowDefinitionsState] = createSignal(false);
  const [definitionOpen, setDefinitionOpen] = createSignal(false);
  const [theme, setThemeState] = createSignal<Theme>(DEFAULT_THEME);
  const [colorMode, setColorModeState] = createSignal<ColorMode>('system');
  const [dark, setDark] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [pendingUndo, setPendingUndo] = createSignal<LocalSwipe | null>(null);
  let shownAt = Date.now();
  let filling = false;
  let exhaustedUntil = 0;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let deck: HTMLDivElement | undefined;
  let gesture: Gesture | null = null;
  /** Live DOM node for every rendered card, keyed by the card object. */
  const elements = new Map<Card, HTMLElement>();
  /** Words swiped in the UI whose local save has not finished yet. */
  const inFlight = new Set<string>();
  /** Swipes waiting to be written; a burst drains into one transaction. */
  let queue: (PendingSwipe & { entry: Departing })[] = [];
  /** Resolves when everything queued so far has been written or rolled back. */
  let saveChain: Promise<void> = Promise.resolve();

  /** Departing cards first so their nodes keep the same list position. */
  const rendered = createMemo(() => [
    ...departing().map((entry) => entry.card),
    ...stack().slice(0, 2),
  ]);

  /**
   * Merge a stack read from IndexedDB into the one on screen, keeping the
   * existing card objects (they key the DOM) and hiding cards that were
   * already swiped but not yet written.
   */
  function reconcile(current: Card[], incoming: Card[]): Card[] {
    const known = new Map(current.map((card) => [card.word, card]));
    return incoming
      .filter((card) => !inFlight.has(card.word))
      .map((card) => known.get(card.word) ?? card);
  }

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
        const known = new Set([
          ...stack().map((card) => card.word),
          ...inFlight,
        ]);
        const next = reconcile(stack(), await appendCards(cards));
        setStack(next);
        if (next.every((card) => known.has(card.word))) misses++;
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

  /** Push the live drag state to the deck; the stylesheet does the geometry. */
  function paintDrag(dx: number, dy: number, grab: Direction, width: number) {
    if (!deck) return;
    const progress = clamp(Math.abs(dx) / commitDistance(width), 0, 1);
    deck.style.setProperty('--drag-x', `${dx}px`);
    deck.style.setProperty('--drag-y', `${dy}px`);
    deck.style.setProperty('--drag-rotate', `${rotation(dx, width, grab)}deg`);
    deck.style.setProperty('--progress', `${progress}`);
  }

  function resetDrag() {
    paintDrag(0, 0, 1, 1);
  }

  /** Horizontal translation that puts the card fully past the viewport edge. */
  function exitX(direction: Direction, rect: DOMRect): number {
    const tilt = (SWIPE.rotateMax * Math.PI) / 180;
    const slop = (rect.height / 2) * Math.sin(tilt) + rect.width * 0.1;
    return direction > 0
      ? window.innerWidth - rect.left + slop
      : -(rect.right + slop);
  }

  function offscreenTransform(direction: Direction, rect: DOMRect): string {
    const x = exitX(direction, rect);
    return `translate(${x}px, 0px) rotate(${rotation(x, rect.width, 1)}deg)`;
  }

  /**
   * Swipe the top card. The stack shifts immediately so the next card is live
   * at once; the swiped card keeps its DOM node and flies out on its own.
   */
  function commit(direction: Direction, release?: Release) {
    const card = stack()[0];
    if (!card || !deck) return;
    const element = elements.get(card);
    const next = stack()[1];
    const nextElement = next ? elements.get(next) : undefined;
    const rect = deck.getBoundingClientRect();
    const entry: Departing = {
      card,
      direction,
      definitionOpen: definitionOpen(),
      animation: null,
    };

    // Capture what is on screen before any state changes move the targets.
    const from = element ? currentTransform(element) : 'none';
    const nextFrom = nextElement ? currentTransform(nextElement) : null;

    if (element) {
      for (const running of element.getAnimations()) running.cancel();
      if (reducedMotion()) {
        entry.animation = element.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: SWIPE.fade,
          easing: 'ease',
          fill: 'forwards',
        });
      } else {
        const plan = planExit({
          x: release?.x ?? 0,
          y: release?.y ?? 0,
          vx: release?.vx ?? 0,
          vy: release?.vy ?? 0,
          direction,
          exitX: exitX(direction, rect),
          width: rect.width,
          height: rect.height,
          grab: release?.grab ?? 1,
        });
        entry.animation = element.animate(
          [
            { transform: from },
            {
              transform: `translate(${plan.x}px, ${plan.y}px) rotate(${plan.rotate}deg)`,
            },
          ],
          { duration: plan.duration, easing: plan.easing, fill: 'forwards' },
        );
        if (nextElement && nextFrom) {
          settle(
            nextElement,
            nextFrom,
            { duration: plan.duration, easing: SETTLE_EASING },
            'rise',
          );
        }
      }
      entry.animation.id = 'exit';
      entry.animation.finished.then(
        () =>
          setDeparting((current) => current.filter((item) => item !== entry)),
        () => {},
      );
    }

    inFlight.add(card.word);
    queue.push({ card, verdict: direction, shownAt, entry });
    batch(() => {
      if (element) setDeparting((current) => [...current, entry]);
      setStack((current) => current.slice(1));
      setDefinitionOpen(showDefinitions());
      setDragging(false);
    });
    resetDrag();
    shownAt = Date.now();
    saveChain = saveChain.then(drainQueue);
  }

  /** Write every queued swipe in one transaction, oldest first. */
  async function drainQueue() {
    const pending = queue;
    if (!pending.length) return;
    queue = [];
    try {
      const swipes = await saveSwipes(pending);
      for (const { card } of pending) inFlight.delete(card.word);
      if (undoTimer) clearTimeout(undoTimer);
      setPendingUndo(swipes[swipes.length - 1]);
      undoTimer = setTimeout(() => setPendingUndo(null), 5000);
      if (stack().length < 60) void fillStack();
    } catch {
      for (const { card, entry } of pending) {
        inFlight.delete(card.word);
        entry.animation?.cancel();
      }
      shownAt = pending[0].shownAt;
      await restoreStack();
      setError('The swipe could not be saved. Please try again.');
    }
  }

  /** Re-read the local stack, the source of truth, after a failed write. */
  async function restoreStack() {
    try {
      const cards = reconcile(stack(), await getStack());
      batch(() => {
        setDeparting((current) =>
          current.filter(
            (item) => !cards.some((card) => card.word === item.card.word),
          ),
        );
        setStack(cards);
      });
    } catch {
      // Keep what is on screen; the next fill will resync.
    }
  }

  /** Let go short of the threshold: spring home, carrying the release velocity. */
  function snapBack(card: Card, dx: number, vx: number) {
    const element = elements.get(card);
    const next = stack()[1];
    const nextElement = next ? elements.get(next) : undefined;
    const from = element ? currentTransform(element) : null;
    const nextFrom = nextElement ? currentTransform(nextElement) : null;
    setDragging(false);
    resetDrag();
    if (reducedMotion()) return;
    const rate = Math.abs(dx) > 1 ? vx / dx : 0;
    const timing = supportsLinearEasing() ? springEasing(rate) : FALLBACK_SNAP;
    if (element && from) settle(element, from, timing, 'snap');
    if (nextElement && nextFrom) settle(nextElement, nextFrom, timing, 'snap');
  }

  async function undo() {
    // Let any swipe still being written land first, then undo the latest one.
    await saveChain;
    const swipe = pendingUndo();
    if (!swipe || !deck) return;
    if (undoTimer) clearTimeout(undoTimer);
    setPendingUndo(null);
    try {
      const restored = reconcile(stack(), await undoSwipe(swipe));
      const entry = departing().find((item) => item.card.word === swipe.word);
      const previousTop = stack()[0];
      const rect = deck.getBoundingClientRect();
      const before = new Map<Card, string>();
      for (const card of [entry?.card, previousTop]) {
        const element = card && elements.get(card);
        if (card && element) before.set(card, currentTransform(element));
      }
      batch(() => {
        if (entry)
          setDeparting((current) => current.filter((item) => item !== entry));
        setStack(restored);
        setDefinitionOpen(showDefinitions());
        setDragging(false);
      });
      resetDrag();
      shownAt = Date.now();
      if (reducedMotion()) return;
      const timing = { duration: SWIPE.enter, easing: SETTLE_EASING };
      const returning = restored[0] && elements.get(restored[0]);
      if (returning) {
        const from =
          before.get(restored[0]) ?? offscreenTransform(swipe.verdict, rect);
        settle(returning, from, timing, 'enter');
      }
      const demoted = previousTop && elements.get(previousTop);
      const demotedFrom = previousTop && before.get(previousTop);
      if (demoted && demotedFrom) settle(demoted, demotedFrom, timing, 'enter');
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

  async function changeColorMode(value: Exclude<ColorMode, 'system'>) {
    try {
      await setColorMode(value);
      setColorModeState(value);
      setDark(value === 'dark');
    } catch {
      setError('Could not save the dark mode setting.');
    }
  }

  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || gesture || !deck) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a')) return;
    const card = stack()[0];
    const top = card && elements.get(card);
    if (!card || !top?.contains(target)) return;
    const rect = deck.getBoundingClientRect();
    gesture = {
      id: event.pointerId,
      card,
      width: rect.width,
      grab: event.clientY < rect.top + rect.height / 2 ? 1 : -1,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: 0,
      offsetY: 0,
      x: 0,
      y: 0,
      active: false,
      cancelled: false,
      samples: [{ x: event.clientX, y: event.clientY, t: event.timeStamp }],
    };
  }

  function pointerMove(event: PointerEvent) {
    if (!gesture || gesture.cancelled || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.active) {
      if (Math.abs(dy) > SWIPE.slop && Math.abs(dy) >= Math.abs(dx)) {
        gesture.cancelled = true;
        return;
      }
      if (Math.abs(dx) <= SWIPE.slop || Math.abs(dx) <= Math.abs(dy)) return;
      gesture.active = true;
      deck?.setPointerCapture(event.pointerId);
      // Catching a card mid-spring: pick it up where it is, no jump.
      const element = elements.get(gesture.card);
      const snapping = element
        ?.getAnimations()
        .filter((animation) => animation.id === 'snap');
      if (element && snapping?.length) {
        const matrix = new DOMMatrixReadOnly(currentTransform(element));
        gesture.offsetX = matrix.m41 - dx;
        gesture.offsetY = matrix.m42 - dy;
        for (const animation of snapping) animation.cancel();
      }
      setDragging(true);
    }
    event.preventDefault();
    gesture.samples.push({
      x: event.clientX,
      y: event.clientY,
      t: event.timeStamp,
    });
    if (gesture.samples.length > 24) gesture.samples.shift();
    gesture.x = dx + gesture.offsetX;
    gesture.y = dy + gesture.offsetY;
    paintDrag(gesture.x, gesture.y, gesture.grab, gesture.width);
  }

  function pointerUp(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const current = gesture;
    gesture = null;
    if (!current.active || current.cancelled) return;
    const x = event.clientX - current.startX + current.offsetX;
    const y = event.clientY - current.startY + current.offsetY;
    const { vx, vy } = releaseVelocity(current.samples, event.timeStamp);
    const verdict = decide(x, vx, current.width);
    if (verdict.action === 'commit') {
      commit(verdict.direction, { x, y, vx, vy, grab: current.grab });
    } else {
      snapBack(current.card, x, vx);
    }
  }

  function pointerCancel(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const current = gesture;
    gesture = null;
    if (current.active) snapBack(current.card, current.x, 0);
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
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!event.repeat) commit(event.key === 'ArrowRight' ? 1 : -1);
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
        setColorModeState(settings.colorMode);
        setDark(applyTheme(settings.theme, settings.colorMode));
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
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (colorMode() === 'system') setDark(systemDark.matches);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && stack().length < 60)
        void fillStack();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    systemDark.addEventListener('change', onSystemThemeChange);
    window.addEventListener('keydown', keyDown);
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => {
      if (undoTimer) clearTimeout(undoTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      systemDark.removeEventListener('change', onSystemThemeChange);
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
            <strong class="display-voice">Settings</strong>
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
            <a
              href="https://kaikki.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
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
        </section>
      </Show>
      <div
        class={`deck-area ${dragging() ? 'is-dragging' : ''}`}
        ref={deck}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerCancel}
      >
        <Show when={!stack().length}>
          <div class="word-card empty-card">
            <span class="card-kicker label-voice">THE NEXT WORD</span>
            <h2 class="display-voice">
              {ready()
                ? online()
                  ? fetching()
                    ? 'Finding words…'
                    : 'You’re all caught up.'
                  : 'Offline for now.'
                : 'Opening your stack…'}
            </h2>
            <p class="body-voice">
              {online()
                ? 'Your next story is on its way.'
                : `Your saved stack is empty. Reconnect for more words; your swipes are safe on this device.`}
            </p>
            <Show when={online() && !fetching()}>
              <button
                class="primary-button label-voice"
                type="button"
                onClick={() => void fillStack(true)}
              >
                Try again
              </button>
            </Show>
          </div>
        </Show>
        <For each={rendered()}>
          {(card) => {
            const entry = () => departing().find((item) => item.card === card);
            const role = createMemo<'departing' | 'top' | 'next'>(() =>
              entry() ? 'departing' : stack()[0] === card ? 'top' : 'next',
            );
            const top = () => role() === 'top';
            const open = () => {
              const current = role();
              if (current === 'top') return definitionOpen();
              if (current === 'departing') return entry()?.definitionOpen;
              return showDefinitions();
            };
            onCleanup(() => elements.delete(card));
            return (
              <article
                ref={(element) => elements.set(card, element)}
                class={`word-card is-${role()}`}
                data-testid={top() ? 'top-card' : undefined}
                aria-hidden={!top()}
              >
                <div class="word-head">
                  <h2 class="display-voice">
                    <a
                      class="word-source"
                      href={`https://en.wiktionary.org/wiki/${encodeURIComponent(card.word)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`View ${card.word} on Wiktionary`}
                      tabindex={top() ? undefined : -1}
                    >
                      {card.word}
                    </a>
                  </h2>
                </div>
                <div class="card-body">
                  <p class="etymology reading-voice">{card.etymology}</p>
                  <Show when={open()}>
                    <div
                      class="definition"
                      id={top() ? 'definition' : undefined}
                    >
                      <span class="definition-label label-voice">
                        {card.pos.join(' · ') || card.defPos}
                      </span>
                      <p class="reading-voice">{card.definition}</p>
                    </div>
                  </Show>
                </div>
                <div class="card-bottom">
                  <button
                    class="definition-toggle label-voice"
                    type="button"
                    tabindex={top() ? undefined : -1}
                    aria-expanded={open()}
                    aria-controls={top() ? 'definition' : undefined}
                    onClick={() => {
                      if (top()) setDefinitionOpen((value) => !value);
                    }}
                  >
                    {open() ? 'Hide definition' : 'Show definition'}{' '}
                    <span aria-hidden="true">{open() ? '−' : '+'}</span>
                  </button>
                </div>
              </article>
            );
          }}
        </For>
      </div>
      <div
        class="deck-controls"
        data-testid="deck-controls"
        data-stack-count={stack().length}
      >
        <button
          class="swipe-button skip-button"
          type="button"
          disabled={!stack().length}
          aria-label="Not for me"
          onClick={() => commit(-1)}
        >
          <svg aria-hidden="true" viewBox="0 0 256 256" fill="none">
            <path
              d="M200 56 56 200M56 56l144 144"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="16"
            />
          </svg>
        </button>
        <button
          class="swipe-button like-button"
          type="button"
          disabled={!stack().length}
          aria-label="Interesting"
          onClick={() => commit(1)}
        >
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
        </button>
      </div>
      <Show when={error()}>
        <p class="inline-error body-voice" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
