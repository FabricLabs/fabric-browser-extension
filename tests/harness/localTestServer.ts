'use strict';

/**
 * Start (or detect) the static + `/api/endpoint` server used by extension UI tests.
 * Matches `scripts/local-test-server.js` (port 3003 by default).
 */

import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

export function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpHeadOk (url: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      const c = res.statusCode;
      resolve(c != null && c >= 200 && c < 300);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll until `GET url` succeeds or timeout.
 */
export async function waitForHttpOk (url: string, maxMs = 45000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await httpHeadOk(url)) return;
    await sleep(250);
  }
  throw new Error(`Timeout waiting for HTTP OK: ${url}`);
}

async function waitForApiHarnessReady (nodeBaseUrl: string, maxMs = 45000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await apiHarnessOk(nodeBaseUrl)) return;
    await sleep(250);
  }
  throw new Error(`Timeout waiting for API harness: ${nodeBaseUrl}`);
}

/** Resolves `true` if the child exited, `false` if `maxMs` elapsed first. */
function waitForChildExit (proc: ChildProcess, maxMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), maxMs);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

let spawned: ChildProcess | null = null;

export interface LocalTestServerHandle {
  /** Use for Playwright `page.goto` (hostname `localhost` for reliable MV3 `content_scripts` matching). */
  baseUrl: string;
  /**
   * Use for Node `http` / `https` clients. The test server binds `127.0.0.1`; using this avoids
   * `localhost` resolving to IPv6 `::1` while the server only listens on IPv4.
   */
  nodeBaseUrl: string;
  /** Stops the process only if this harness spawned it. */
  stop: () => Promise<void>;
}

/**
 * If something is already serving `test.html`, reuse it. Otherwise spawn `scripts/local-test-server.js`.
 */
async function apiHarnessOk (baseUrl: string): Promise<boolean> {
  try {
    const u = `${baseUrl.replace(/\/$/, '')}/api/endpoint`;
    const j: unknown = await new Promise((resolve, reject) => {
      http.get(u, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
    const o = j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
    return !!(o && o.success === true && o.source === 'local-test-server');
  } catch {
    return false;
  }
}

/**
 * Default **3044** avoids clashing with `webpack serve` on 3003 (test.html may exist without `/api/endpoint`).
 */
export async function ensureLocalTestServer (port = 3044): Promise<LocalTestServerHandle> {
  const baseUrl = `http://localhost:${port}`;
  const nodeBaseUrl = `http://127.0.0.1:${port}`;
  const testPage = `${baseUrl}/test.html`;

  if ((await httpHeadOk(testPage)) && (await apiHarnessOk(nodeBaseUrl))) {
    return {
      baseUrl,
      nodeBaseUrl,
      stop: async () => {}
    };
  }

  const root = path.resolve(__dirname, '..', '..');
  const script = path.join(root, 'scripts', 'local-test-server.js');
  spawned = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'pipe'
  });

  const onErr = (data: Buffer) => {
    const s = data.toString();
    if (s.trim()) console.error('[test-server]', s.trim());
  };
  spawned.stderr?.on('data', onErr);
  spawned.stdout?.on('data', onErr);

  spawned.on('error', (err) => {
    console.error('[test-server] spawn failed:', err);
  });

  try {
    await waitForHttpOk(testPage, 45000);
    await waitForApiHarnessReady(nodeBaseUrl, 45000);
  } catch (e) {
    try {
      spawned.kill('SIGTERM');
    } catch (_) {}
    spawned = null;
    throw e;
  }

  return {
    baseUrl,
    nodeBaseUrl,
    stop: async () => {
      if (!spawned) return;
      const p = spawned;
      spawned = null;
      try {
        p.kill('SIGTERM');
      } catch (_) {}
      const exited = await waitForChildExit(p, 3000);
      if (!exited) {
        try {
          p.kill('SIGKILL');
        } catch (_) {}
      }
    }
  };
}
