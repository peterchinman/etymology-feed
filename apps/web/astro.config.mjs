import solid from '@astrojs/solid-js';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  integrations: [solid()],
  vite: {
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:8787',
        '/auth': 'http://127.0.0.1:8787',
      },
    },
  },
});
