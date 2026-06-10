import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:8787',
      '/items': 'http://localhost:8787',
      '/files': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
      '/events': 'http://localhost:8787'
    }
  }
});
