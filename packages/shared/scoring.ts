/** The heuristic prior range emitted by database/derive_etymology.py (§4.3). */
export const MIN_PRIOR = 0.2;
export const MAX_PRIOR = 0.8;
/**
 * A left swipe is the default action in a swipe feed, so it is weak evidence:
 * it counts as DISLIKE_WEIGHT of a negative (§6.2). Weighting lefts by the
 * odds of the base like-rate, p / (1 - p), makes `score >= 0.5` mean "at or
 * above the average card". 0.25 assumes a 20% like-rate until §6.5 reports it.
 */
export const DEFAULT_DISLIKE_WEIGHT = 0.25;
/** Confirmed means clearly above average, not merely at it. */
export const DEFAULT_CONFIRM_SCORE = 0.55;

/**
 * Beta posterior parameters used by Thompson sampling in §6.2: a flat Beta(1, 1)
 * prior on the weighted scale, so both shape parameters stay >= 1 and the
 * heuristic prior never enters the score.
 */
export function betaShapeParameters(
  likes = 0,
  dislikes = 0,
  dislikeWeight = DEFAULT_DISLIKE_WEIGHT,
): { alpha: number; beta: number } {
  return { alpha: likes + 1, beta: dislikeWeight * dislikes + 1 };
}

export function posteriorMean(
  likes: number,
  dislikes: number,
  dislikeWeight = DEFAULT_DISLIKE_WEIGHT,
): number {
  const { alpha, beta } = betaShapeParameters(likes, dislikes, dislikeWeight);
  return alpha / (alpha + beta);
}

/** The weight at which the average card scores exactly 0.5 (§4.3, §6.5). */
export function suggestedDislikeWeight(likeRate: number): number | null {
  if (!(likeRate > 0) || !(likeRate < 1)) return null;
  return likeRate / (1 - likeRate);
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

/**
 * Feed lanes by information state (§6.1). A card's lane is what we know about
 * it, not which slot happened to show it, so `bucket` on a swipe records the
 * lane the card actually came from.
 */
export type Bucket = 'confirmed' | 'promising' | 'fresh' | 'wild';
export const LANES: readonly Bucket[] = [
  'confirmed',
  'promising',
  'fresh',
  'wild',
];
export type SlotCounts = Readonly<Record<Bucket, number>>;
export const DEFAULT_SLOT_COUNTS: SlotCounts = {
  confirmed: 6,
  promising: 6,
  fresh: 6,
  wild: 2,
};

/** Spreads each lane's slots evenly through one block (largest remainder). */
export function slotPattern(
  counts: SlotCounts = DEFAULT_SLOT_COUNTS,
): Bucket[] {
  const total = LANES.reduce((sum, lane) => sum + counts[lane], 0);
  if (
    !Number.isInteger(total) ||
    total < 1 ||
    LANES.some((lane) => !Number.isInteger(counts[lane]) || counts[lane] < 0)
  )
    throw new RangeError('Invalid slot counts.');
  const used: Record<Bucket, number> = {
    confirmed: 0,
    promising: 0,
    fresh: 0,
    wild: 0,
  };
  return Array.from({ length: total }, (_, i) => {
    const owed = (lane: Bucket) =>
      (counts[lane] * (i + 1)) / total - used[lane];
    const lane = LANES.filter((lane) => used[lane] < counts[lane]).sort(
      (a, b) => owed(b) - owed(a),
    )[0];
    used[lane]++;
    return lane;
  });
}

export const SLOT_PATTERN: readonly Bucket[] = slotPattern();

export function interleave(
  count: number,
  slots: readonly Bucket[] = SLOT_PATTERN,
): Bucket[] {
  return Array.from({ length: count }, (_, i) => slots[i % slots.length]);
}

/**
 * Fill-through order for a slot: its own lane, then the lanes below it, then
 * the lanes above it. An empty confirmed lane hands its slots to promising,
 * then fresh; nothing is left blank while any lane still has unseen cards.
 */
export function fillOrder(slot: Bucket): Bucket[] {
  const index = LANES.indexOf(slot);
  return [...LANES.slice(index), ...LANES.slice(0, index)];
}

export function pickFromLanes<T>(
  slot: Bucket,
  lanes: Readonly<Partial<Record<Bucket, readonly T[]>>>,
  seen: Set<T>,
): { item: T; lane: Bucket } | undefined {
  for (const lane of fillOrder(slot)) {
    const item = lanes[lane]?.find((candidate) => !seen.has(candidate));
    if (item !== undefined) {
      seen.add(item);
      return { item, lane };
    }
  }
  return undefined;
}
