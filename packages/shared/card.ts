import type { Bucket } from './scoring';

export type Card = {
  id: string;
  word: string;
  etymNo: number | null;
  ipa: string | null;
  pos: string[];
  definition: string;
  defPos: string;
  etymology: string;
  tier: string;
  shape: string;
  etymBand: string;
  bucket?: Bucket;
};

/** Eligibility follows the displayed sense, not casing or other headword senses. */
export function isFeedEligible(
  card: Pick<Card, 'defPos'>,
  includeProperNouns = false,
): boolean {
  return includeProperNouns || card.defPos !== 'proper noun';
}
