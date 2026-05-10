'use strict';

/**
 * Release gate: `POST /services/rpc` with a bearer that matches
 * `buildBearerToken` from `@fabric/http/middlewares/auth`.
 *
 * The Playwright `webServer` only enables JSON-RPC + `tokenSecret` when
 * `FABRIC_JSONRPC_AUTH_TEST=1` (see `npm run test:ui:release-gate`).
 */
import { test, expect } from './extension.fixtures';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeBearerToken } = require('../helpers/fabricHttpBearerToken.js');

const TOKEN_SECRET = 'fabric-extension-release-gate';

test.describe('release gate: @fabric/http bearer + JSON-RPC', () => {
  test('POST /services/rpc with Authorization: Bearer succeeds (when server uses tokenSecret)', async ({ request, baseURL }) => {
    test.skip(
      !process.env.FABRIC_JSONRPC_AUTH_TEST,
      'Set FABRIC_JSONRPC_AUTH_TEST=1 for webServer (e.g. npm run test:ui:release-gate)'
    );

    expect(baseURL).toBeTruthy();
    const token = makeBearerToken(TOKEN_SECRET, { sub: 'release-gate' });
    const rpc = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ReleaseGatePing',
      params: []
    });
    const res = await request.post(new URL('/services/rpc', baseURL).toString(), {
      data: rpc,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`
      }
    });
    const text = await res.text();
    expect(res.status(), text).toBe(200);
    const body = JSON.parse(text) as { jsonrpc: string; result: { ok: boolean; t: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result).toEqual({ ok: true, t: 'ReleaseGatePing' });
  });
});
