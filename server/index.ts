// LEFT! LEFT! LEFT! multiplayer server: Socket.IO rooms + static hosting of the built client.

import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/shared/protocol';
import { registerHandlers } from './networking/registerHandlers';
import { RoomManager } from './rooms/RoomManager';

function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

// In production, hosting platforms (Render, Railway, Fly...) assign the port via PORT.
// In development PORT is ignored because dev tools often set it for the Vite server.
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.GAME_PORT || (DEV ? undefined : process.env.PORT) || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ALLOWED_ORIGINS = CORS_ORIGIN === '*' ? null : CORS_ORIGIN.split(',').map((s) => s.trim().replace(/\/$/, ''));
const GRACE_MS = Number(process.env.RECONNECT_GRACE_SECONDS || 60) * 1000;

const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: ALLOWED_ORIGINS ?? true },
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 5000,
  pingTimeout: 10000,
  connectionStateRecovery: undefined,
});
const rooms = new RoomManager(io, GRACE_MS);
registerHandlers(io, rooms);

// CORS for plain HTTP routes too, so a client hosted elsewhere (e.g. Netlify)
// can run its "is the game server online?" check.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (!ALLOWED_ORIGINS || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.count, uptime: Math.round(process.uptime()) });
});

// Serve the production client build when it exists.
const here = path.dirname(fileURLToPath(import.meta.url));
const distCandidates = [path.resolve(here, '../dist'), path.resolve(process.cwd(), 'dist')];
const dist = distCandidates.find((d) => existsSync(path.join(d, 'index.html')));
if (dist) {
  app.use(express.static(dist, { maxAge: '1h', index: 'index.html' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[left-left-left] port ${PORT} is already in use - set GAME_PORT to a free port (see .env.example)`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, () => {
  console.log(`[left-left-left] server listening on http://localhost:${PORT}`);
  if (dist) console.log(`[left-left-left] serving client build from ${dist}`);
  else console.log('[left-left-left] no client build found - run "npm run dev" (Vite) or "npm run build"');
});

const shutdown = () => {
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
