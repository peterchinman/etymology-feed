import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
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
