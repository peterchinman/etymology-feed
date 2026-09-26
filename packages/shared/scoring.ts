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

export function posteriorMean(
  prior: number,
  likes: number,
  dislikes: number,
  strength = DEFAULT_PRIOR_STRENGTH,
): number {
  const { alpha, beta } = betaShapeParameters(prior, likes, dislikes, strength);
  return alpha / (alpha + beta);
}

export function betaVariance(alpha: number, beta: number): number {
  const total = alpha + beta;
  return (alpha * beta) / (total * total * (total + 1));
}

// Marsaglia–Tsang gamma draw, including the shape<1 transform for future tunings.
function normal(random: () => number): number {
  const u = Math.max(Number.MIN_VALUE, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function gamma(shape: number, random: () => number): number {
  if (shape < 1) return gamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = random();
    if (
      u < 1 - 0.0331 * x ** 4 ||
      Math.log(u) < (x * x) / 2 + d * (1 - v + Math.log(v))
    )
      return d * v;
  }
}

export function betaDraw(
  alpha: number,
  beta: number,
  random: () => number = Math.random,
): number {
  const x = gamma(alpha, random);
  return x / (x + gamma(beta, random));
}

export type Bucket = 'rec' | 'unknown' | 'wild';
export const SLOT_PATTERN: readonly Bucket[] = [
  'rec',
  'rec',
  'rec',
  'unknown',
  'rec',
  'wild',
  'rec',
  'unknown',
  'rec',
  'rec',
  'unknown',
  'rec',
  'rec',
  'unknown',
  'rec',
  'wild',
  'rec',
  'unknown',
  'rec',
  'unknown',
];

export function slotPattern(
  rec: number,
  unknown: number,
  wild: number,
): Bucket[] {
  if (rec === 12 && unknown === 6 && wild === 2) return [...SLOT_PATTERN];
  const counts = { rec, unknown, wild };
  const total = rec + unknown + wild;
  if (
    !Number.isInteger(total) ||
    total < 1 ||
    Object.values(counts).some((value) => !Number.isInteger(value) || value < 0)
  )
    throw new RangeError('Invalid slot counts.');
  const used = { rec: 0, unknown: 0, wild: 0 };
  return Array.from({ length: total }, (_, i) => {
    const bucket = (Object.keys(counts) as Bucket[])
      .filter((key) => used[key] < counts[key])
      .sort(
        (a, b) =>
          (counts[b] * (i + 1)) / total -
          used[b] -
          ((counts[a] * (i + 1)) / total - used[a]),
      )[0];
    used[bucket]++;
    return bucket;
  });
}

export function interleave(
  count: number,
  slots: readonly Bucket[] = SLOT_PATTERN,
): Bucket[] {
  return Array.from({ length: count }, (_, i) => slots[i % slots.length]);
}

export function pickAvailable<T>(
  candidates: readonly T[],
  seen: Set<T>,
  fallback: readonly T[] = [],
): T | undefined {
  const chosen =
    candidates.find((candidate) => !seen.has(candidate)) ??
    fallback.find((candidate) => !seen.has(candidate));
  if (chosen !== undefined) seen.add(chosen);
  return chosen;
}
