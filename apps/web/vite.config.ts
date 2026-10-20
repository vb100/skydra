import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In cloud environments the load balancer routes /api to the API service; locally Vite does.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
