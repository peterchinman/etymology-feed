import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { anonymous, genericOAuth } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import { mergeAnonymousAccount } from './accounts';
import * as schema from './db/schema';

export function configuredProviders(env: CloudflareBindings): string[] {
  return [
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? ['google'] : []),
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? ['github'] : []),
    ...(env.MOCK_OAUTH_ISSUER ? ['mock'] : []),
  ];
}

/**
 * Rate-limit key for a client address. One IPv6 host usually controls a whole
 * /64, so every address in a /64 shares a key. Returns null without an address.
 */
export function clientNetwork(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const gap =
    tail === undefined ? 0 : Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array<string>(gap).fill('0'), ...right];
  const prefix = groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * Every anonymous user can rate each card once, so new guests are the only
 * unbounded source of votes. Cap them per client network. Cloudflare always
 * sets CF-Connecting-IP in production and local Wrangler sets it too; only
 * direct test requests arrive without an address, and those are not limited.
 */
const limitAnonymousSignIn = (env: CloudflareBindings) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path !== '/sign-in/anonymous') return;
    const network = clientNetwork(ctx.headers?.get('CF-Connecting-IP'));
    if (network && !(await env.SESSION_RATE.limit({ key: network })).success)
      throw new APIError('TOO_MANY_REQUESTS', {
        code: 'RATE_LIMITED',
        message: 'Too many new sessions from this network. Try again shortly.',
      });
  });

export function createAuth(env: CloudflareBindings, origin: string) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL || origin,
    basePath: '/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.APP, { schema }), {
      provider: 'sqlite',
      schema,
    }),
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    hooks: { before: limitAnonymousSignIn(env) },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
    },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        secure: origin.startsWith('https:'),
        sameSite: 'lax',
      },
    },
    plugins: [
      anonymous({
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          await mergeAnonymousAccount(
            env,
            anonymousUser.user.id,
            newUser.user.id,
          );
        },
      }),
      ...(env.MOCK_OAUTH_ISSUER
        ? [
            genericOAuth({
              config: [
                {
                  providerId: 'mock',
                  clientId: 'etymology-e2e',
                  clientSecret: 'etymology-e2e-secret',
                  discoveryUrl: `${env.MOCK_OAUTH_ISSUER}/.well-known/openid-configuration`,
                  scopes: ['openid', 'email', 'profile'],
                  disableProviderLogout: true,
                },
              ],
            }),
          ]
        : []),
    ],
  });
}
