import { describe, expect, test } from 'vitest';
import { resolveWelcome } from './local';

describe('resolveWelcome', () => {
  test('a first visit keeps the welcome until it is dismissed', () => {
    expect(resolveWelcome(null, false)).toBe('pending');
    // The feed saves a stack while the welcome is up; it must stay up.
    expect(resolveWelcome('pending', true)).toBe('pending');
  });

  test('someone who used the app before the welcome existed skips it', () => {
    expect(resolveWelcome(null, true)).toBe('done');
  });

  test('a dismissed welcome stays dismissed', () => {
    expect(resolveWelcome('done', false)).toBe('done');
  });

  test('an unrecognized stored value counts as unset', () => {
    expect(resolveWelcome('yes', false)).toBe('pending');
  });
});
