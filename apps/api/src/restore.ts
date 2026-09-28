import worker from './index';

// Used only by the isolated restore drill, never by the production entrypoint.
interface RestoreBindings extends CloudflareBindings {
  RESTORE_TOKEN: string;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: RestoreBindings, ctx: ExecutionContext) {
    const supplied = new TextEncoder().encode(
      request.headers.get('X-Restore-Token') ?? '',
    );
    const expected = new TextEncoder().encode(env.RESTORE_TOKEN ?? '');
    if (
      !expected.length ||
      supplied.length !== expected.length ||
      !crypto.subtle.timingSafeEqual(supplied, expected)
    ) {
      return new Response('Not found', { status: 404 });
    }
    const path = new URL(request.url).pathname;
    if (
      path.startsWith('/api/') ||
      path.startsWith('/auth/') ||
      path === '/healthz'
    ) {
      return worker.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
