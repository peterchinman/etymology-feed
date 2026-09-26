interface CloudflareBindings {
  BETTER_AUTH_SECRET: string;
  ADMIN_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    ADMIN_TOKEN: string;
  }
}
