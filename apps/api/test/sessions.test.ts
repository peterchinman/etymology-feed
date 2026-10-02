import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { clientNetwork } from '../src/auth';

const LIMIT = 10;

/** Rate-limit windows align to the wall clock; start well inside one. */
async function freshWindow() {
  const remaining = 60_000 - (Date.now() % 60_000);
  if (remaining < 15_000)
    await new Promise((resolve) => setTimeout(resolve, remaining + 100));
}

function signIn(ip: string) {
  return SELF.fetch('http://localhost/auth/sign-in/anonymous', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': ip,
      'Content-Type': 'application/json',
      Origin: 'http://localhost',
    },
    body: '{}',
  });
}

function me(ip: string, cookie?: string) {
  return SELF.fetch('http://localhost/api/me', {
    headers: { 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
  });
}

describe('clientNetwork', () => {
  it('keys IPv4 by address and IPv6 by /64', () => {
    expect(clientNetwork(undefined)).toBeNull();
    expect(clientNetwork('')).toBeNull();
    expect(clientNetwork('203.0.113.9')).toBe('203.0.113.9');
    expect(clientNetwork('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientNetwork('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientNetwork('2001:0DB8:0001:0002:ffff:1:2:3')).toBe(
      '2001:db8:1:2::/64',
    );
    expect(clientNetwork('2001:db8::7')).toBe('2001:db8:0:0::/64');
    expect(clientNetwork('1::2:3:4:5:6:7')).toBe('1:0:2:3::/64');
    expect(clientNetwork('::1')).toBe('0:0:0:0::/64');
  });
});

describe('anonymous session rate limit', () => {
  it('caps new guests per address on the sign-in route', async () => {
    await freshWindow();
    for (let i = 0; i < LIMIT; i++)
      expect((await signIn('198.51.100.7')).status).toBe(200);
    expect((await signIn('198.51.100.7')).status).toBe(429);
    expect((await signIn('198.51.100.8')).status).toBe(200);
  }, 30_000);

  it('applies the same cap when the API creates the guest', async () => {
    await freshWindow();
    const first = await me('192.0.2.44');
    expect(first.status).toBe(200);
    const cookie = first.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();
    for (let i = 1; i < LIMIT; i++)
      expect((await me('192.0.2.44')).status).toBe(200);

    const limited = await me('192.0.2.44');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('set-cookie')).toBeNull();
    expect(await limited.json()).toEqual({
      error: { code: 'rate_limited', message: 'Try again shortly.' },
    });
    // The sign-in route shares the bucket.
    expect((await signIn('192.0.2.44')).status).toBe(429);
    // Existing sessions are never counted or refused.
    expect((await me('192.0.2.44', cookie)).status).toBe(200);
  }, 30_000);

  it('shares one bucket across an IPv6 /64', async () => {
    await freshWindow();
    for (let i = 0; i < LIMIT; i++)
      expect((await signIn(`2001:db8:5:6::${i + 1}`)).status).toBe(200);
    expect((await signIn('2001:db8:5:6:abcd::99')).status).toBe(429);
    expect((await signIn('2001:db8:5:7::1')).status).toBe(200);
  }, 30_000);
});
