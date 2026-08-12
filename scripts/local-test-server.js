'use strict';

const path = require('path');
const HTTPServer = require('@fabric/http/types/server');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3003);
// Webpack emits the loadable extension (and popup.html) under `assets/`, not `src/`.
const assetsRoot = path.resolve(__dirname, '..', 'assets');

const jsonRpcAuthTest = process.env.FABRIC_JSONRPC_AUTH_TEST === '1' || process.env.FABRIC_JSONRPC_AUTH_TEST === 'true';
const tokenSecret = process.env.FABRIC_HTTP_TEST_TOKEN_SECRET || (
  jsonRpcAuthTest ? 'fabric-extension-release-gate' : null
);

const serverOpts = {
  host,
  hostname: host,
  interface: host,
  port,
  listen: true,
  assets: assetsRoot,
  cors: true
};

if (jsonRpcAuthTest && tokenSecret) {
  serverOpts.jsonRpc = {
    enabled: true,
    paths: ['/services/rpc'],
    requireAuth: true
  };
  serverOpts.tokenSecret = tokenSecret;
}

const server = new HTTPServer(serverOpts);

if (jsonRpcAuthTest && tokenSecret) {
  server._registerMethod('ReleaseGatePing', function () {
    return { ok: true, t: 'ReleaseGatePing' };
  });
}

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
  if (jsonRpcAuthTest && tokenSecret) {
    console.log('[fabric-passport] JSON-RPC auth test: POST /services/rpc (ReleaseGatePing) with Bearer (buildBearerToken from @fabric/http/middlewares/auth)');
  }
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
