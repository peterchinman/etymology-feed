import { describe, expect, it } from 'vitest';
import {
  betaDraw,
  betaShapeParameters,
  betaVariance,
  DEFAULT_PRIOR_STRENGTH,
  interleave,
  MAX_PRIOR,
  MIN_PRIOR,
  pickAvailable,
  posteriorMean,
  SLOT_PATTERN,
} from './scoring';

describe('cold-start Beta prior', () => {
  it('keeps both shape parameters at least 1 for every emitted prior', () => {
    // The derive script rounds priors to four decimal places.
    for (let tick = MIN_PRIOR * 10_000; tick <= MAX_PRIOR * 10_000; tick++) {
      const prior = tick / 10_000;
      const { alpha, beta } = betaShapeParameters(prior);
      expect(alpha).toBeGreaterThanOrEqual(1);
      expect(beta).toBeGreaterThanOrEqual(1);
      expect(alpha + beta).toBeCloseTo(DEFAULT_PRIOR_STRENGTH);
    }
  });
});

describe('feed scoring and composition', () => {
  it('matches the posterior mean and Beta variance by sampling', () => {
    const prior = 0.6;
    const likes = 8;
    const dislikes = 3;
    const { alpha, beta } = betaShapeParameters(prior, likes, dislikes);
    const samples = Array.from({ length: 20_000 }, () => betaDraw(alpha, beta));
    const mean =
      samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      samples.length;
    expect(mean).toBeCloseTo(posteriorMean(prior, likes, dislikes), 2);
    expect(variance).toBeCloseTo(betaVariance(alpha, beta), 2);
  });

  it('repeats the 12/6/2 pattern in every block', () => {
    const slots = interleave(100);
    expect(slots.slice(0, 20)).toEqual(SLOT_PATTERN);
    for (let i = 0; i < 100; i += 20) {
      expect(
        slots.slice(i, i + 20).filter((slot) => slot === 'rec'),
      ).toHaveLength(12);
      expect(
        slots.slice(i, i + 20).filter((slot) => slot === 'unknown'),
      ).toHaveLength(6);
      expect(
        slots.slice(i, i + 20).filter((slot) => slot === 'wild'),
      ).toHaveLength(2);
    }
  });

  it('refills from the fallback pool and does not repeat over 5,000 single-card fetches', () => {
    const known = new Set<number>();
    const rec = [1, 2];
    const wild = Array.from({ length: 5_000 }, (_, i) => i + 3);
    for (let i = 0; i < 5_000; i++) {
      const slot = interleave(1)[0];
      const word = pickAvailable(slot === 'rec' ? rec : wild, known, wild);
      expect(word).toBeDefined();
    }
    expect(known.size).toBe(5_000);
  });
});
