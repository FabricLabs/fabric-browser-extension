'use strict';

/**
 * Cross-platform defaults for mesh-remote UI tests (avoid bash `${VAR:-default}` on Windows).
 */

const { spawn } = require('child_process');

process.env.FABRIC_ACTION_DEBUG_URL =
  process.env.FABRIC_ACTION_DEBUG_URL || 'http://127.0.0.1:3044/api/endpoint';
process.env.FABRIC_HUB_BASE_URL =
  process.env.FABRIC_HUB_BASE_URL || 'http://127.0.0.1:8080';

const args = ['playwright', 'test', 'tests/ui/hub-remote-mesh-bridge.spec.ts'];
const child = spawn('npx', args, { stdio: 'inherit', shell: true, env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
