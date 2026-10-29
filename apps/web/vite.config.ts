import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In cloud environments the load balancer routes /api to the API service; locally Vite does.
    // SKYDRA_API_URL points a second local instance elsewhere (e.g. a separate QA database).
    proxy: { '/api': process.env.SKYDRA_API_URL ?? 'http://localhost:3000' },
  },
});
