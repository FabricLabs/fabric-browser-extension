'use strict';

/**
 * Runs Playwright release-gate spec with JSON-RPC + bearer enabled on
 * `scripts/local-test-server.js` (see FABRIC_JSONRPC_AUTH_TEST).
 */
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
process.env.FABRIC_JSONRPC_AUTH_TEST = '1';
process.env.FABRIC_HTTP_TEST_TOKEN_SECRET = 'fabric-extension-release-gate';

const child = spawn(
  'npx',
  ['playwright', 'test', 'tests/ui/release-gate-fabric-auth.spec.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  }
);
child.on('exit', (code) => {
  process.exit(typeof code === 'number' ? code : 1);
});
