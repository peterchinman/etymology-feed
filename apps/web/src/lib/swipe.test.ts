import { describe, expect, test } from 'vitest';
import {
  commitDistance,
  decide,
  planExit,
  releaseVelocity,
  rotation,
  SWIPE,
  springEasing,
} from './swipe';

/** Evaluate cubic-bezier(x1, y1, x2, y2) as a timing function at time u. */
function bezier(easing: string, u: number): number {
  const [x1, y1, x2, y2] = easing
    .slice('cubic-bezier('.length, -1)
    .split(',')
    .map(Number);
  const at = (a: number, b: number, s: number) =>
    3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (at(x1, x2, mid) < u) low = mid;
    else high = mid;
  }
  return at(y1, y2, (low + high) / 2);
}

function linearStops(easing: string): number[] {
  return easing.slice('linear('.length, -1).split(',').map(Number);
}

describe('releaseVelocity', () => {
  test('measures the trailing window, not the whole gesture', () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 20, y: 0, t: 400 },
      { x: 40, y: 0, t: 800 },
      { x: 140, y: 10, t: 850 },
      { x: 240, y: 20, t: 900 },
    ];
    const { vx, vy } = releaseVelocity(samples, 905);
    expect(vx).toBeCloseTo(2, 5);
    expect(vy).toBeCloseTo(0.2, 5);
  });

  test('a pause before lifting reads as zero', () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 200, y: 0, t: 100 },
    ];
    expect(releaseVelocity(samples, 350)).toEqual({ vx: 0, vy: 0 });
  });
});

describe('decide', () => {
  const width = 360;
  test('a slow drag commits only past the distance threshold', () => {
    expect(decide(commitDistance(width) - 1, 0, width)).toEqual({
      action: 'snap',
    });
    expect(decide(commitDistance(width) + 1, 0, width)).toEqual({
      action: 'commit',
      direction: 1,
    });
  });
  test('a flick commits from a short distance', () => {
    expect(decide(24, 1.4, width)).toEqual({ action: 'commit', direction: 1 });
    expect(decide(-24, -1.4, width)).toEqual({
      action: 'commit',
      direction: -1,
    });
  });
  test('throwing the card back toward the middle cancels', () => {
    expect(decide(200, -3, width)).toEqual({ action: 'snap' });
  });
  test('a decisive reversal near the middle follows the hand', () => {
    expect(decide(-6, 2, width)).toEqual({ action: 'commit', direction: 1 });
  });
  test('the commit distance is capped for wide cards', () => {
    expect(commitDistance(1200)).toBe(SWIPE.thresholdMax);
  });
});

describe('planExit', () => {
  const base = {
    x: 120,
    y: 0,
    vy: 0,
    direction: 1 as const,
    exitX: 520,
    width: 360,
    height: 560,
    grab: 1 as const,
  };

  test('a comfortable release coasts at the release speed', () => {
    const plan = planExit({ ...base, vx: 2 });
    expect(plan.duration).toBe(200);
    const speed = (u: number, du = 1e-4) =>
      ((bezier(plan.easing, u + du) - bezier(plan.easing, u)) / du) *
      (400 / plan.duration);
    expect(speed(0)).toBeCloseTo(2, 2);
    expect(speed(0.5)).toBeCloseTo(2, 2);
  });

  test('a slow release leaves at its own speed and accelerates away', () => {
    const plan = planExit({ ...base, vx: 0.4 });
    expect(plan.duration).toBe(SWIPE.exitMax);
    const du = 1e-4;
    const initial = (bezier(plan.easing, du) / du) * (400 / plan.duration);
    expect(initial).toBeCloseTo(0.4, 2);
    expect(bezier(plan.easing, 0.5)).toBeLessThan(0.5);
    expect(bezier(plan.easing, 1)).toBeCloseTo(1, 6);
  });

  test('a button press launches at half its average speed and accelerates', () => {
    const plan = planExit({ ...base, x: 0, vx: 0 });
    expect(plan.duration).toBe(SWIPE.press.duration);
    const du = 1e-4;
    const average = 520 / plan.duration;
    const initial = (bezier(plan.easing, du) / du) * average;
    expect(initial).toBeCloseTo(SWIPE.press.launch * average, 2);
    const final =
      ((bezier(plan.easing, 1) - bezier(plan.easing, 1 - du)) / du) * average;
    expect(final).toBeGreaterThan(initial);
    expect(bezier(plan.easing, 1)).toBeCloseTo(1, 6);
  });

  test('a violent flick is clamped to the minimum and stays monotonic', () => {
    const plan = planExit({ ...base, vx: 12 });
    expect(plan.duration).toBe(SWIPE.exitMin);
    let previous = 0;
    for (let u = 0.05; u <= 1; u += 0.05) {
      const p = bezier(plan.easing, u);
      expect(p).toBeGreaterThan(previous);
      previous = p;
    }
  });

  test('vertical drift follows the finger but stays bounded', () => {
    expect(planExit({ ...base, vx: 2, vy: 0.5 }).y).toBeCloseTo(100, 6);
    expect(planExit({ ...base, vx: 2, vy: 9 }).y).toBe(280);
  });

  test('the exit tilt continues the drag tilt', () => {
    expect(planExit({ ...base, vx: 2 }).rotate).toBeCloseTo(
      rotation(520, 360, 1),
    );
    expect(rotation(126, 360, 1)).toBeCloseTo(4.9, 5);
    expect(rotation(126, 360, -1)).toBeCloseTo(-4.9, 5);
    expect(rotation(2000, 360, 1)).toBe(SWIPE.rotateMax);
  });
});

describe('springEasing', () => {
  test('returns to rest with a small overshoot and ends exactly at 1', () => {
    const { easing, duration } = springEasing(0);
    const stops = linearStops(easing);
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(1);
    expect(Math.max(...stops)).toBeGreaterThan(1);
    expect(Math.max(...stops)).toBeLessThan(1.05);
    expect(duration).toBeGreaterThan(250);
    expect(duration).toBeLessThan(600);
  });

  test('a release still moving outward overshoots outward first', () => {
    const stops = linearStops(springEasing(0.02).easing);
    expect(Math.min(...stops.slice(0, 6))).toBeLessThan(0);
  });
});
