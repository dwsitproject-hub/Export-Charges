import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API is reached through this proxy, so the browser sees one origin
// (like the WAF/SLB routing in production) and SameSite=Strict cookies work.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3100' },
  },
});
