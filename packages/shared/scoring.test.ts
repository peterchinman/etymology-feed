import { describe, expect, it } from "vitest";
import {
  betaShapeParameters,
  DEFAULT_PRIOR_STRENGTH,
  MAX_PRIOR,
  MIN_PRIOR,
} from "./scoring";

describe("cold-start Beta prior", () => {
  it("keeps both shape parameters at least 1 for every emitted prior", () => {
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
