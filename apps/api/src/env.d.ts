interface CloudflareBindings {
  BETTER_AUTH_SECRET: string;
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
  }
}
