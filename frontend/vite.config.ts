import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * DWS Hub SDK script tag, first in <head> so it loads before the app (SDK-INTEGRATION-GUIDE.md). Added only when the
 * build sets VITE_HUB_SDK_URL and VITE_HUB_SDK_KEY; VITE_GIT_SHA becomes data-release, so Sentinel reads the code of
 * exactly that release.
 */
function hubSdk(env: Record<string, string>): Plugin {
  return {
    name: 'dws-hub-sdk',
    transformIndexHtml() {
      if (!env.VITE_HUB_SDK_URL || !env.VITE_HUB_SDK_KEY) return [];
      const attrs: Record<string, string | boolean> = { src: env.VITE_HUB_SDK_URL, 'data-app-key': env.VITE_HUB_SDK_KEY, defer: true };
      if (env.VITE_GIT_SHA) attrs['data-release'] = env.VITE_GIT_SHA;
      return [{ tag: 'script', attrs, injectTo: 'head-prepend' }];
    },
  };
}

// In development the API is reached through this proxy, so the browser sees one origin
// (like the WAF/SLB routing in production) and SameSite=Strict cookies work.
export default defineConfig(({ mode }) => ({
  plugins: [react(), hubSdk(loadEnv(mode, process.cwd(), 'VITE_'))],
  // Readable stack traces in the Hub and for Sentinel.
  esbuild: { keepNames: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3100' },
  },
}));
