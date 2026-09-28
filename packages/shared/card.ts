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
  /** Total likes when fetched; absent on cards cached before counts shipped. */
  likeCount?: number;
  bucket?: Bucket;
};
