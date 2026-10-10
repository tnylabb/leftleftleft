// Entry point: WebGL check, physics engine init, then the App.

import RAPIER from '@dimforge/rapier3d-compat';
import { App } from './core/App';
import { Renderer, webglAvailable } from './rendering/Renderer';
import './ui/styles.css';

async function boot() {
  const root = document.getElementById('app')!;
  const uiRoot = document.getElementById('ui')!;
  const status = document.getElementById('boot-status');
  if (!webglAvailable()) {
    document.getElementById('boot')?.remove();
    uiRoot.innerHTML = `<div class="screen show menu-bg fatal"><h1 class="title" style="font-size:56px">NO WEBGL</h1>
      <div class="panel" style="max-width:600px">LEFT! LEFT! LEFT! needs WebGL 2. Please use an up-to-date Chrome, Edge or Firefox,
      enable hardware acceleration in your browser settings, and update your graphics drivers.</div></div>`;
    return;
  }
  if (status) status.textContent = 'Starting physics engine…';
  await RAPIER.init();
  const renderer = new Renderer(root);
  const app = new App(renderer, uiRoot);
  document.getElementById('boot')?.remove();
  app.start();
}

boot().catch((err) => {
  console.error(err);
  const status = document.getElementById('boot-status');
  if (status) status.textContent = `Failed to start: ${err instanceof Error ? err.message : err}`;
});
