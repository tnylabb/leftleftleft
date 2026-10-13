import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverPort = Number(env.GAME_PORT || 3001);
  return {
    // Relative asset paths so the same build works at a domain root (Render,
    // Netlify) and in a sub-folder (GitHub Pages: https://user.github.io/repo/).
    base: './',
    server: {
      host: true,
      port: Number(env.CLIENT_PORT || 5173),
      proxy: {
        // In development the game server runs separately; proxy Socket.IO so the
        // client always talks to its own origin (works on LAN too).
        '/socket.io': {
          target: `http://localhost:${serverPort}`,
          ws: true,
          changeOrigin: true,
        },
        '/health': `http://localhost:${serverPort}`,
        '/api': `http://localhost:${serverPort}`,
      },
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      chunkSizeWarningLimit: 5000, // Rapier ships its WASM inline (~4.3 MB)
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            rapier: ['@dimforge/rapier3d-compat'],
          },
        },
      },
    },
  };
});
