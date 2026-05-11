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
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new Error(`Release gate: response is not JSON. First 200 chars: ${text.slice(0, 200)}`);
    }
    expect(body, 'parsed JSON body').toEqual(expect.any(Object));
    const o = body as Record<string, unknown>;
    expect(typeof o.jsonrpc, 'jsonrpc field').toBe('string');
    expect(o.jsonrpc).toBe('2.0');
    expect(o.result, 'result field').toEqual(expect.any(Object));
    expect(o.result).toEqual({ ok: true, t: 'ReleaseGatePing' });
  });
});
