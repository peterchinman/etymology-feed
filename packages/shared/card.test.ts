import { describe, expect, it } from 'vitest';
import { type Card, isFeedEligible } from './card';

describe('proper noun preference', () => {
  it('defaults off and can be enabled explicitly', () => {
    expect(isFeedEligible({ defPos: 'proper noun' })).toBe(false);
    expect(isFeedEligible({ defPos: 'proper noun' }, true)).toBe(true);
  });
  it('uses the paired sense rather than capitalization or other senses', () => {
    const card = {
      word: 'Capitalized',
      defPos: 'noun',
      pos: ['proper noun', 'noun'],
    } as Card;
    expect(isFeedEligible(card)).toBe(true);
    expect(isFeedEligible({ ...card, defPos: 'proper noun' })).toBe(false);
  });
});
