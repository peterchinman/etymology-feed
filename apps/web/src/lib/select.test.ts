import { describe, expect, test } from 'vitest';
import { wordAt } from './select';

describe('wordAt', () => {
  const text = 'From Latin tessella, “small cube”.';
  const pick = (offset: number) => {
    const span = wordAt(text, offset);
    return span && text.slice(...span);
  };

  test('finds the word around a caret inside it', () => {
    expect(pick(13)).toBe('tessella');
  });

  test('a caret at either edge of a word belongs to it', () => {
    expect(pick(5)).toBe('Latin');
    expect(pick(10)).toBe('Latin');
  });

  test('punctuation and spaces select nothing', () => {
    expect(pick(20)).toBeNull();
    expect(wordAt('  ', 1)).toBeNull();
  });

  test('handles non-Latin scripts', () => {
    const greek = 'from κόρη (kórē)';
    const span = wordAt(greek, 7);
    expect(span && greek.slice(...span)).toBe('κόρη');
  });
});
