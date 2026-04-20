'use strict';

const path = require('path');
const HTTPServer = require('@fabric/http/types/server');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3003);
// Webpack emits the loadable extension (and popup.html) under `assets/`, not `src/`.
const assetsRoot = path.resolve(__dirname, '..', 'assets');

const server = new HTTPServer({
  host,
  hostname: host,
  interface: host,
  port,
  listen: true,
  assets: assetsRoot,
  cors: true
});

server._addRoute('get', '/api/endpoint', (req, res) => {
  return res.status(200).json({
    success: true,
    source: 'local-test-server',
    ts: new Date().toISOString()
  });
});

async function main () {
  await server.start();
  // Note: `HTTPServer` registers its own `GET /` before custom routes; open popup explicitly.
  console.log(`[fabric-passport] popup UI: http://${host}:${port}/popup.html`);
  console.log(`[fabric-passport] content-script test page: http://${host}:${port}/test.html`);
  console.log(`[fabric-passport] Hub mesh bridge (postMessage → background WebRTC): http://${host}:${port}/hub-mesh-bridge.html`);
}

main().catch((err) => {
  console.error('[fabric-passport] failed to start local test server:', err);
  process.exit(1);
});

async function shutdown () {
  try {
    await server.stop();
  } catch (err) {
    console.error('[fabric-passport] shutdown error:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
