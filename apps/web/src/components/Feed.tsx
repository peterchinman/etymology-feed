import { type Card, isFeedEligible } from '@etymology-feed/shared/card';
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
  FEED_SETTINGS_CHANGED,
  getSettings,
  getStack,
  getStackPreview,
  type LocalSwipe,
  type PendingSwipe,
  saveSwipes,
  undoSwipe,
} from '../lib/local';
import { hasSelectionIn, selectWordAt } from '../lib/select';
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
import { drainSync } from '../lib/sync';
import CardFooter from './CardFooter';

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
  const [storedStack, setStack] = createSignal<Card[]>([]);
  const [includeProperNouns, setIncludeProperNouns] = createSignal(false);
  const stack = createMemo(() =>
    storedStack().filter((card) => isFeedEligible(card, includeProperNouns())),
  );
  const [departing, setDeparting] = createSignal<Departing[]>([]);
  const [dragging, setDragging] = createSignal(false);
  /** The verdict a release would commit right now, shown on its button. */
  const [armed, setArmed] = createSignal<Direction | 0>(0);
  const [ready, setReady] = createSignal(false);
  const [online, setOnline] = createSignal(true);
  const [fetching, setFetching] = createSignal(false);
  const [error, setError] = createSignal('');
  const [definitionOpen, setDefinitionOpen] = createSignal(false);
  const [pendingUndo, setPendingUndo] = createSignal<LocalSwipe | null>(null);
  const [demoLikeCount, setDemoLikeCount] = createSignal<number | null>(null);
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
  let swipesSinceSync = 0;

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
    const known = new Map(current.map((card) => [card.id, card]));
    return incoming
      .filter((card) => !inFlight.has(card.id))
      .map((card) => known.get(card.id) ?? card);
  }

  async function fillStack(force = false) {
    if (filling || !navigator.onLine || Date.now() < exhaustedUntil) return;
    if (!force && stack().length >= 60) return;
    filling = true;
    setFetching(true);
    let misses = 0;
    try {
      // The server records served cards; IndexedDB also filters after cookie loss.
      for (
        let attempt = 0;
        attempt < 6 && navigator.onLine && stack().length < 150;
        attempt++
      ) {
        const cards = await fetchCards();
        const known = new Set([...stack().map((card) => card.id), ...inFlight]);
        const next = reconcile(stack(), await appendCards(cards));
        setStack(next);
        if (
          next
            .filter((card) => isFeedEligible(card, includeProperNouns()))
            .every((card) => known.has(card.id))
        )
          misses++;
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
    setArmed(0);
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
    // The cached preview is display-only until IndexedDB confirms the stack.
    if (!ready()) return;
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

    inFlight.add(card.id);
    queue.push({ card, verdict: direction, shownAt, entry });
    batch(() => {
      if (element) setDeparting((current) => [...current, entry]);
      setStack((current) => current.filter((item) => item.id !== card.id));
      setDefinitionOpen(false);
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
      swipesSinceSync += swipes.length;
      if (swipesSinceSync >= 10) {
        swipesSinceSync = 0;
        void drainSync();
      }
      for (const { card } of pending) inFlight.delete(card.id);
      if (undoTimer) clearTimeout(undoTimer);
      setPendingUndo(swipes[swipes.length - 1]);
      undoTimer = setTimeout(() => setPendingUndo(null), 5000);
      if (stack().length < 60) void fillStack();
    } catch {
      for (const { card, entry } of pending) {
        inFlight.delete(card.id);
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
            (item) => !cards.some((card) => card.id === item.card.id),
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
      const entry = departing().find((item) => item.card.id === swipe.cardId);
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
        setDefinitionOpen(false);
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

  function pointerDown(event: PointerEvent) {
    // Only a finger drags the card; mouse and pen use the buttons or keys.
    if (!ready() || event.pointerType !== 'touch' || gesture || !deck) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a')) return;
    const card = stack()[0];
    const top = card && elements.get(card);
    if (!card || !top?.contains(target)) return;
    // Selected text holds the card still; a tap elsewhere clears it.
    if (hasSelectionIn(top)) return;
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
      // A long press that started selecting text is not a swipe.
      if (hasSelectionIn(elements.get(gesture.card))) {
        gesture.cancelled = true;
        return;
      }
      // Lock the initial intent, with a little tolerance for diagonal swipes.
      if (
        Math.abs(dy) > SWIPE.slop &&
        Math.abs(dy) > Math.abs(dx) * SWIPE.scrollBias
      ) {
        gesture.cancelled = true;
        return;
      }
      if (Math.abs(dx) <= SWIPE.slop) return;
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
    // Light the button a release would commit to now, using the same
    // decision the release makes, so the cue never promises a snap-back.
    const { vx } = releaseVelocity(gesture.samples, event.timeStamp);
    const verdict = decide(gesture.x, vx, gesture.width);
    setArmed(verdict.action === 'commit' ? verdict.direction : 0);
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

  /** The last quick, still touch on the card text, for spotting a double tap. */
  let lastTap: { x: number; y: number; t: number } | null = null;
  let touchStart: { x: number; y: number; t: number } | null = null;

  function touchBegan(event: TouchEvent) {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    touchStart = touch
      ? { x: touch.clientX, y: touch.clientY, t: event.timeStamp }
      : null;
  }

  function touchMoved(event: TouchEvent) {
    // Canceling pointermove cannot stop native panning. Once the pointer
    // handler locks a swipe, claim touchmove before the scroller takes over
    // and sends pointercancel. Vertical gestures keep native scrolling.
    if (gesture?.active && event.touches.length === 1 && event.cancelable) {
      event.preventDefault();
    }
  }

  /** A second tap on the card text selects the word under the finger. */
  function touchEnded(event: TouchEvent) {
    const start = touchStart;
    const touch = event.changedTouches[0];
    touchStart = null;
    const target = event.target as HTMLElement;
    const top = stack()[0] && elements.get(stack()[0]);
    const onText =
      top?.contains(target) &&
      !!target.closest('.card-body') &&
      !target.closest('button, a');
    const tap =
      start &&
      touch &&
      event.timeStamp - start.t < SWIPE.tapTime &&
      Math.hypot(touch.clientX - start.x, touch.clientY - start.y) <=
        SWIPE.slop;
    if (!tap || !onText || !top) {
      lastTap = null;
      return;
    }
    const here = { x: touch.clientX, y: touch.clientY, t: event.timeStamp };
    const second =
      lastTap &&
      here.t - lastTap.t < SWIPE.doubleTapTime &&
      Math.hypot(here.x - lastTap.x, here.y - lastTap.y) <=
        SWIPE.doubleTapReach;
    if (!second) {
      lastTap = here;
      return;
    }
    lastTap = null;
    // Stop the tap's emulated mouse events, which would collapse the selection.
    event.preventDefault();
    selectWordAt(here.x, here.y, top);
  }

  function keyDown(event: KeyboardEvent) {
    if (document.querySelector('dialog[open]')) return;
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
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      const value = new URLSearchParams(window.location.search).get(
        'demoLikes',
      );
      if (value && /^\d{1,6}$/.test(value)) setDemoLikeCount(Number(value));
    }
    setOnline(navigator.onLine);
    setStack(getStackPreview());
    void (async () => {
      try {
        const [cards, settings] = await Promise.all([
          getStack(),
          getSettings(),
        ]);
        setStack(reconcile(stack(), cards));
        setIncludeProperNouns(settings.includeProperNouns);
        applyTheme(settings.theme, settings.colorMode);
        setReady(true);
        void drainSync();
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
      void drainSync();
      void fillStack(true);
    };
    const onOffline = () => setOnline(false);
    const onFeedSettings = async () => {
      setReady(false);
      gesture = null;
      setDragging(false);
      resetDrag();
      await saveChain;
      try {
        const settings = await getSettings();
        setIncludeProperNouns(settings.includeProperNouns);
        setDefinitionOpen(false);
        exhaustedUntil = 0;
        await restoreStack();
        void fillStack(true);
      } catch {
        setError('Could not load your feed setting. Please reload.');
      } finally {
        setReady(true);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void drainSync();
      if (document.visibilityState === 'visible' && stack().length < 60)
        void fillStack();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener(FEED_SETTINGS_CHANGED, onFeedSettings);
    deck?.addEventListener('touchstart', touchBegan, { passive: true });
    deck?.addEventListener('touchmove', touchMoved, { passive: false });
    deck?.addEventListener('touchend', touchEnded, { passive: false });
    window.addEventListener('keydown', keyDown);
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => {
      deck?.removeEventListener('touchstart', touchBegan);
      deck?.removeEventListener('touchmove', touchMoved);
      deck?.removeEventListener('touchend', touchEnded);
      if (undoTimer) clearTimeout(undoTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener(FEED_SETTINGS_CHANGED, onFeedSettings);
      window.removeEventListener('keydown', keyDown);
      document.removeEventListener('visibilitychange', onVisible);
    });
  });

  return (
    <section class="feed-page page-wrap">
      <h1 class="sr-only">Feed</h1>
      <div
        class={`deck-area ${dragging() ? 'is-dragging' : ''}`}
        ref={deck}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerCancel}
      >
        <Show when={!ready() && !stack().length}>
          <div class="word-card" aria-hidden="true" />
        </Show>
        <Show when={ready() && !stack().length}>
          <div class="word-card empty-card">
            <span class="card-kicker label-voice">THE NEXT WORD</span>
            <h2 class="display-voice">
              {online()
                ? fetching()
                  ? 'Finding words…'
                  : 'You’re all caught up.'
                : 'Offline for now.'}
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
            const shownLikeCount = () =>
              top() && demoLikeCount() !== null
                ? demoLikeCount()
                : card.likeCount;
            const [overflows, setOverflows] = createSignal(false);
            let definition!: HTMLParagraphElement;
            onMount(() => {
              const measure = () => {
                const style = getComputedStyle(definition);
                const lineHeight = Number.parseFloat(style.lineHeight);
                const lines = Number.parseInt(
                  style.getPropertyValue('--definition-lines'),
                  10,
                );
                setOverflows(definition.scrollHeight > lineHeight * lines + 1);
              };
              const observer = new ResizeObserver(measure);
              observer.observe(definition);
              document.fonts.addEventListener('loadingdone', measure);
              window.addEventListener('resize', measure);
              onCleanup(() => {
                observer.disconnect();
                document.fonts.removeEventListener('loadingdone', measure);
                window.removeEventListener('resize', measure);
              });
            });
            const open = () => {
              const current = role();
              if (current === 'top') return definitionOpen();
              if (current === 'departing') return entry()?.definitionOpen;
              return false;
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
                  <h2 class="display-voice">{card.word}</h2>
                </div>
                <div class="card-body">
                  <div class="definition">
                    <span class="definition-label label-voice">
                      {card.defPos}
                    </span>
                    <div
                      class="definition-preview reading-voice"
                      classList={{ 'is-collapsed': !open() && overflows() }}
                    >
                      <p
                        ref={definition}
                        class="reading-voice"
                        classList={{ 'is-clamped': !open() }}
                        id={top() ? 'definition' : undefined}
                      >
                        {card.definition}
                      </p>
                      <Show when={overflows()}>
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
                          <Show when={!open()}>
                            <span aria-hidden="true">… </span>
                          </Show>
                          {open() ? 'See less' : 'See more'}
                        </button>
                      </Show>
                    </div>
                  </div>
                  <p class="etymology reading-voice">{card.etymology}</p>
                </div>
                <CardFooter
                  word={card.word}
                  etymNo={card.etymNo}
                  likeCount={shownLikeCount() ?? undefined}
                  tabIndex={top() ? undefined : -1}
                />
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
          class={`swipe-button skip-button${armed() === -1 ? ' is-armed' : ''}`}
          type="button"
          disabled={!ready() || !stack().length}
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
          class={`swipe-button like-button${armed() === 1 ? ' is-armed' : ''}`}
          type="button"
          disabled={!ready() || !stack().length}
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
