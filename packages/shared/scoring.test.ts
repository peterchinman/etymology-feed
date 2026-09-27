import { describe, expect, it } from 'vitest';
import {
  betaDraw,
  betaShapeParameters,
  betaVariance,
  DEFAULT_BASE_RATE,
  DEFAULT_PRIOR_STRENGTH,
  fillOrder,
  interleave,
  LANES,
  pickFromLanes,
  posteriorMean,
  SLOT_PATTERN,
  slotPattern,
} from './scoring';

describe('flat rated-lane prior', () => {
  it('is Beta(1, 1) before any rating, so Thompson sampling stays well-behaved', () => {
    const { alpha, beta } = betaShapeParameters(DEFAULT_BASE_RATE);
    expect(alpha).toBeGreaterThanOrEqual(1);
    expect(beta).toBeGreaterThanOrEqual(1);
    expect(alpha + beta).toBeCloseTo(DEFAULT_PRIOR_STRENGTH);
  });

  it('lets a single rating move the score decisively', () => {
    expect(posteriorMean(DEFAULT_BASE_RATE, 0, 0)).toBeCloseTo(0.5);
    expect(posteriorMean(DEFAULT_BASE_RATE, 1, 0)).toBeCloseTo(2 / 3);
    expect(posteriorMean(DEFAULT_BASE_RATE, 0, 1)).toBeCloseTo(1 / 3);
    expect(posteriorMean(DEFAULT_BASE_RATE, 2, 0)).toBeCloseTo(0.75);
    // The confirmed threshold score >= 0.5 is exactly likes >= dislikes.
    expect(posteriorMean(DEFAULT_BASE_RATE, 3, 3)).toBeCloseTo(0.5);
    expect(posteriorMean(DEFAULT_BASE_RATE, 2, 3)).toBeLessThan(0.5);
  });

  it('matches the posterior mean and Beta variance by sampling', () => {
    const likes = 8;
    const dislikes = 3;
    const { alpha, beta } = betaShapeParameters(
      DEFAULT_BASE_RATE,
      likes,
      dislikes,
    );
    const samples = Array.from({ length: 20_000 }, () => betaDraw(alpha, beta));
    const mean =
      samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      samples.length;
    expect(mean).toBeCloseTo(
      posteriorMean(DEFAULT_BASE_RATE, likes, dislikes),
      2,
    );
    expect(variance).toBeCloseTo(betaVariance(alpha, beta), 2);
  });
});

describe('lane composition', () => {
  it('repeats the 6/6/6/2 pattern in every block and spreads each lane out', () => {
    const slots = interleave(100);
    expect(slots.slice(0, 20)).toEqual(SLOT_PATTERN);
    for (let i = 0; i < 100; i += 20) {
      const block = slots.slice(i, i + 20);
      expect(block.filter((slot) => slot === 'confirmed')).toHaveLength(6);
      expect(block.filter((slot) => slot === 'promising')).toHaveLength(6);
      expect(block.filter((slot) => slot === 'fresh')).toHaveLength(6);
      expect(block.filter((slot) => slot === 'wild')).toHaveLength(2);
    }
    // No lane is bunched: any window of four slots holds at least two lanes.
    for (let i = 0; i + 4 <= SLOT_PATTERN.length; i++)
      expect(new Set(SLOT_PATTERN.slice(i, i + 4)).size).toBeGreaterThan(1);
    expect(() =>
      slotPattern({ confirmed: 0, promising: 0, fresh: 0, wild: 0 }),
    ).toThrow(RangeError);
    expect(
      slotPattern({ confirmed: 0, promising: 0, fresh: 1, wild: 0 }),
    ).toEqual(['fresh']);
  });

  it('fills through to the lanes below before the lanes above', () => {
    expect(fillOrder('confirmed')).toEqual(LANES);
    expect(fillOrder('promising')).toEqual([
      'promising',
      'fresh',
      'wild',
      'confirmed',
    ]);
    const seen = new Set<string>();
    const lanes = { confirmed: [], promising: ['p1'], fresh: ['f1', 'f2'] };
    expect(pickFromLanes('confirmed', lanes, seen)).toEqual({
      item: 'p1',
      lane: 'promising',
    });
    expect(pickFromLanes('confirmed', lanes, seen)).toEqual({
      item: 'f1',
      lane: 'fresh',
    });
    expect(pickFromLanes('fresh', lanes, seen)).toEqual({
      item: 'f2',
      lane: 'fresh',
    });
    expect(pickFromLanes('promising', lanes, seen)).toBeUndefined();
    expect(seen).toEqual(new Set(['p1', 'f1', 'f2']));
  });

  it('does not repeat over 5,000 single-card fetches from a thin lane set', () => {
    const seen = new Set<number>();
    const lanes = {
      confirmed: [1, 2],
      promising: [3],
      fresh: Array.from({ length: 5_000 }, (_, i) => i + 4),
    };
    for (let i = 0; i < 5_000; i++) {
      const slot = interleave(1)[0];
      expect(pickFromLanes(slot, lanes, seen)).toBeDefined();
    }
    expect(seen.size).toBe(5_000);
  });
});
