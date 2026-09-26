/** The range emitted by database/derive_etymology.py. */
export const MIN_PRIOR = 0.2;
export const MAX_PRIOR = 0.8;
export const DEFAULT_PRIOR_STRENGTH = 5;

/** Beta posterior parameters used by Thompson sampling in §6.2. */
export function betaShapeParameters(
  prior: number,
  likes = 0,
  dislikes = 0,
  strength = DEFAULT_PRIOR_STRENGTH,
): { alpha: number; beta: number } {
  const alpha0 = strength * prior;
  return {
    alpha: likes + alpha0,
    beta: dislikes + (strength - alpha0),
  };
}
