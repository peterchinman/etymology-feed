import { anonymousClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/solid';

export const authClient = createAuthClient({
  basePath: '/auth',
  plugins: [anonymousClient()],
});
let ready: Promise<boolean> | undefined;
export function resetAuthSession(): void {
  ready = undefined;
}
export function ensureAnonymousSession(): Promise<boolean> {
  ready ??= (async () => {
    const session = await authClient.getSession();
    if (session.data?.user) return false;
    const created = await authClient.signIn.anonymous();
    if (created.error)
      throw new Error(created.error.message ?? 'Anonymous sign-in failed.');
    return true;
  })().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}
