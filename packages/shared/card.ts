export type Card = {
  word: string;
  ipa: string | null;
  pos: string[];
  definition: string;
  defPos: string;
  etymology: string;
  tier: string;
  shape: string;
  etymBand: string;
  bucket?: 'rec' | 'unknown' | 'wild';
};
