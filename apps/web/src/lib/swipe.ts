/**
 * Swipe physics. Everything here is a pure function of numbers so the feel can
 * be reasoned about and tested without a browser.
 *
 * Model: the card is an object with position and velocity. While the finger is
 * down it tracks the finger 1:1. On release we look at where the card *would*
 * end up and either let it continue off-screen at (roughly) the speed it was
 * released with, or pull it back to rest with a spring that also inherits the
 * release velocity. There is never a jump in velocity at the moment of release.
 */

export type Sample = { x: number; y: number; t: number };
export type Direction = 1 | -1;

export const SWIPE = {
  /** Pointer travel before a drag is recognized (px). */
  slop: 10,
  /** A touch shorter than this that stays within `slop` is a tap (ms). */
  tapTime: 300,
  /** Two taps this close in time and space are a double tap (ms, px). */
  doubleTapTime: 350,
  doubleTapReach: 30,
  /** Distance past which a release commits, as a fraction of card width... */
  threshold: 0.35,
  /** ...capped so wide desktop cards do not demand a huge drag (px). */
  thresholdMax: 200,
  /** Trailing window used to measure release velocity (ms). */
  velocityWindow: 100,
  /** How far ahead we project the release velocity when deciding (ms). */
  projection: 180,
  /** A release moving at least this fast commits regardless of distance (px/ms). */
  flick: 0.7,
  /** Rotation for a drag of one full card width, and its cap (deg). */
  rotatePerWidth: 14,
  rotateMax: 20,
  /** Exit duration bounds for a released drag (ms). Flicks approach the minimum. */
  exitMin: 100,
  exitMax: 240,
  /**
   * A swipe from a key or button has no hand speed, so it gets a crisp launch:
   * a fixed duration, starting at `launch` × its average speed and accelerating.
   */
  press: { duration: 160, launch: 0.5 },
  /** Snap-back spring (mass 1, per second). */
  spring: { stiffness: 400, damping: 30 },
  /** Undo return (ms). */
  enter: 360,
  /** Reduced-motion crossfade (ms). */
  fade: 160,
} as const;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Commit distance for a card of the given width. */
export function commitDistance(width: number): number {
  return Math.min(width * SWIPE.threshold, SWIPE.thresholdMax);
}

/**
 * Velocity at release (px/ms), measured over the trailing window rather than
 * the whole gesture, so a flick after a slow start still reads as a flick and a
 * pause before lifting reads as zero.
 */
export function releaseVelocity(
  samples: readonly Sample[],
  now: number,
): { vx: number; vy: number } {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > SWIPE.velocityWindow) return { vx: 0, vy: 0 };
  let first = samples[0];
  for (const sample of samples) {
    if (last.t - sample.t <= SWIPE.velocityWindow) {
      first = sample;
      break;
    }
  }
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/** Tilt for a horizontal offset. `grab` is +1 when held above center, -1 below. */
export function rotation(dx: number, width: number, grab: Direction): number {
  return (
    clamp(
      (dx / Math.max(1, width)) * SWIPE.rotatePerWidth,
      -SWIPE.rotateMax,
      SWIPE.rotateMax,
    ) * grab
  );
}

/**
 * Decide what a release does. Projects the release velocity a little way ahead
 * so a flick can commit from a short distance, while a card thrown back toward
 * the middle from far out is a cancel, not a commit the other way.
 */
export function decide(
  dx: number,
  vx: number,
  width: number,
): { action: 'commit'; direction: Direction } | { action: 'snap' } {
  const distance = commitDistance(width);
  const projected = dx + vx * SWIPE.projection;
  const direction: Direction = projected < 0 ? -1 : 1;
  const flicked = Math.abs(vx) >= SWIPE.flick && Math.sign(vx) === direction;
  if (Math.abs(projected) < distance && !flicked) return { action: 'snap' };
  const thrownBack =
    Math.sign(dx) !== direction && Math.abs(dx) > distance * 0.5;
  if (thrownBack) return { action: 'snap' };
  return { action: 'commit', direction };
}

export type ExitPlan = {
  duration: number;
  easing: string;
  x: number;
  y: number;
  rotate: number;
};

/**
 * Plan the flight off-screen. Position follows x(t) = x0 + v0·t + ½·a·t², with
 * `a` chosen so the card reaches `exitX` in `duration`. When the release speed
 * is comfortable, a = 0 and the card simply coasts at the speed it left the
 * finger. A slow release accelerates away; a violent one eases off slightly
 * instead of teleporting. That quadratic is exactly the cubic-bezier below.
 */
export function planExit(input: {
  x: number;
  y: number;
  vx: number;
  vy: number;
  direction: Direction;
  exitX: number;
  width: number;
  height: number;
  grab: Direction;
}): ExitPlan {
  const { x, y, vx, vy, direction, exitX, width, height, grab } = input;
  const distance = Math.max(1, Math.abs(exitX - x));
  const v0 = Math.max(0, vx * direction);
  // alpha is the ratio of start speed to average speed: 1 coasts, <1 speeds up.
  let duration: number = SWIPE.press.duration;
  let alpha: number = SWIPE.press.launch;
  if (v0 > 0) {
    duration = clamp(distance / v0, SWIPE.exitMin, SWIPE.exitMax);
    alpha = clamp((v0 * duration) / distance, 0, 1.9);
  }
  const easing = `cubic-bezier(0.3333, ${round(alpha / 3)}, 0.6667, ${round(alpha / 3 + 1 / 3)})`;
  const drift = clamp(vy * duration, -height / 2, height / 2);
  return {
    duration,
    easing,
    x: exitX,
    y: y + drift,
    rotate: rotation(exitX, width, grab),
  };
}

/**
 * A damped spring from displacement 1 to 0 with normalized initial rate `rate`
 * (per ms, positive = still moving away from rest), sampled into a CSS
 * `linear()` easing. Progress may pass 1, which is the overshoot.
 */
export function springEasing(rate: number): {
  easing: string;
  duration: number;
} {
  const { stiffness, damping } = SWIPE.spring;
  const w0 = Math.sqrt(stiffness) / 1000;
  const zeta = damping / (2 * Math.sqrt(stiffness));
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const v0 = clamp(rate, -0.02, 0.02);
  const displacement = (t: number) =>
    Math.exp(-zeta * w0 * t) *
    (Math.cos(wd * t) + ((v0 + zeta * w0) / wd) * Math.sin(wd * t));
  let duration = 0;
  for (let t = 0; t <= 800; t += 4) {
    if (Math.abs(displacement(t)) > 0.003) duration = t;
  }
  duration = Math.min(800, duration + 16);
  const stops = 48;
  const values: number[] = [];
  for (let i = 0; i <= stops; i++) {
    values.push(
      i === stops ? 1 : round(1 - displacement((duration * i) / stops)),
    );
  }
  return { easing: `linear(${values.join(', ')})`, duration };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
