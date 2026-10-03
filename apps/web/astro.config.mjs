import solid from '@astrojs/solid-js';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  integrations: [solid()],
  vite: {
    server: {
      // Keep the browser's Host header. The Worker derives Better Auth's
      // trusted origin from the request URL, so a rewritten Host would make
      // every cookie-bearing auth POST from localhost:4321 fail the origin
      // check. Vite's string shorthand would set changeOrigin: true.
      proxy: {
        '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
        '/auth': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      },
    },
  },
});
