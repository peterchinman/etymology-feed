import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';

export function createAuth(env: CloudflareBindings, origin: string) {
  return betterAuth({
    baseURL: origin,
    basePath: '/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.APP, { schema }), {
      provider: 'sqlite',
      schema,
    }),
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        secure: origin.startsWith('https:'),
        sameSite: 'lax',
      },
    },
    plugins: [anonymous()],
  });
}
