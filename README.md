# `@fabric/passport`
[![codecov](https://codecov.io/gh/FabricLabs/fabric-browser-extension/graph/badge.svg)](https://codecov.io/gh/FabricLabs/fabric-browser-extension)

Browser Extension for managing identities and logging in to Fabric applications.

Push/PR workflows run **`npm run report:coverage`** (see `.github/workflows/test.yaml`) and upload **`reports/coverage.lcov`** to [Codecov](https://codecov.io/gh/FabricLabs/fabric-browser-extension), matching **FabricLabs/fabric** / **fabric-http**.

## Features
Additional extension features and configurations can be accessed in the settings page on the top-right corner of the first home-page
- Wallet password, also used to encrypt data before being stored
- Import/Export seed phrases
- Enable/Disable Chains for each identity
- Create additional identities

## Quick Start
1. `npm i`
2. `npm run build` (one-off compile) or `npm start` (webpack dev server for iteration)
3. Open `chrome://extensions/` in Chromium
4. Enable **Developer mode**, click **Load unpacked**, and select this repo’s **`assets/`** directory (webpack output)
5. The extension should appear in the toolbar; pin it if you want quick access.

## Local Extension Test Harness
Use a minimal local server (backed by `@fabric/http`) that serves the **compiled `assets/` tree** (same files you load as unpacked in Chromium):

1. In one terminal, start the harness (runs `npm run build`, then the server):
   - `npm run serve:test`
2. In Chromium, load unpacked extension from `assets/` (see Quick Start).
3. **Popup UI in a normal tab** (no `chrome-extension://` URL): open `http://127.0.0.1:3003/popup.html` (or set `PORT` — e.g. `PORT=3044` matches `playwright.config.ts` / `npm run test:ui`). `IdentityManager` falls back when `chrome.storage` is missing so you can click through the UI; persistence only works inside the real extension popup.
4. **Content script harness:** open `http://127.0.0.1:3003/test.html` on the same port as step 3.
5. Validate on `test.html`:
   - `window.fabricExtension`
   - `window.fabricExtension.chrome.runtime.sendMessage({ type: 'FABRIC_ACTION' }, console.log)` → response includes `success: true` and `source: 'local-test-server'`.

### Remote Hub (localhost:8080) mesh integration
With **`@fabric/http` `npm run sample:hub`** (or a full **@fabric/hub** on the same port) running, the extension can be tested against that origin’s `hub-mesh-bridge` page and the same `postMessage` contract as the built-in harness. Port **8080** is the default for `test:ui:mesh-remote` if you do not set `FABRIC_HUB_BASE_URL` yourself.

- Start the stub (from a `fabric-http` clone): `npm run sample:hub`
- In this repo, after `npm run build` and `npx playwright install chromium`: `npm run test:ui:mesh-remote`

This runs only **`tests/ui/hub-remote-mesh-bridge.spec.ts`**, which calls **Register/Unregister** on `http://127.0.0.1:8080/hub-mesh-bridge.html` and asserts `fabric_mesh_hub_registration` in the extension. Use `127.0.0.1` or `localhost` consistently with how you open the Hub in a browser. Optional: `FABRIC_HUB_MESH_PATH` if the bridge page lives at a different path.

The content script is matched on both **`http://localhost:*`** and **`http://127.0.0.1:*`** (`src/manifest.json`) so loopback dev servers on either host receive the bridge.

The default **`npm run test:ui`** includes a **skipped** placeholder for the remote suite when `FABRIC_HUB_BASE_URL` is not set, so you can see the opt-in in the report.

### Trusted Hub HTTP: `X-Fabric-Identity` + traffic metrics
After **Connect & register** succeeds (same flow that calls `GetNetworkStatus` and `RegisterWebRTCPeer` with your public key), the extension records that node’s **origin** in `fabric_trusted_http_origins` and the service worker:

- Injects **`X-Fabric-Identity`** on normal document/asset/XHR requests to those origins only (`declarativeNetRequest`, rule ids 100–199). Value is the same **`id1…` bech32m** string as the Passport UI (x-only witness + `id` HRP, see `src/utils/fabricIdentityBech32.ts`); stored `id` is reused when it already decodes as bech32m. **No xprv** — public material in line with `RegisterWebRTCPeer`.
- Observes **`webRequest`** for **rough** stats (request count + `Content-Length` sums) on the same origins; in-memory until the service worker restarts. **`chrome.runtime.sendMessage({ type: 'GET_FABRIC_TRAFFIC_METRICS' })`** returns `{ origins, byOrigin }` for a future settings UI.

This is **off** for every other site. `@fabric/http` with `cors: true` allows the header in CORS preflight (`x-fabric-identity`).

### Shared identity across two origins (proof in tests)
**`tests/ui/two-origin-identity.spec.ts`** logs in with the standard test seed, records the **truncated xpub** on identity detail, opens **`/test.html`** on both **`http://localhost:3044`** and **`http://127.0.0.1:3044`** (different origins, same port), then confirms the xpub line is **unchanged**. That is the same wallet profile in one extension — not two separate identities per site.

### Release gate: `@fabric/http` auth
**Bearer + JSON-RPC** is covered in **`tests/ui/release-gate-fabric-auth.spec.ts`**, using `buildBearerToken` from `@fabric/http/middlewares/auth` and `POST /services/rpc` (method `ReleaseGatePing`) when the test server enables JSON-RPC auth. Run after build + Playwright install:

- `npm run test:ui:release-gate` — sets `FABRIC_JSONRPC_AUTH_TEST=1` for `scripts/local-test-server.js` and runs only this spec. Normal `npm run test:ui` does **not** turn on JSON-RPC `requireAuth` so the rest of the UI suite is unchanged.

See `node_modules/@fabric/http/docs/RELEASE_GATE.md` when `@fabric/http` is linked, or the [fabric-http `docs/RELEASE_GATE.md`](https://github.com/FabricLabs/fabric-http/blob/feature/v0.1.0-RC1/docs/RELEASE_GATE.md) on the RC branch.

## New Wallet Creation User Flow
1. Upon clicking the extension icon for the first time, a new tab opens with onboarding modals showcasing extension features and options to import or create a new seed.
2. Users will be asked to set an encryption password (which could later be changed in the settings)
3. When choosing to create a new seed, a 12 word seed phrase will be given and seed verification page will display afterwards.
4. After onboarding, open a **Fabric** web app to exercise the extension against a real origin — for example **[hub.fabric.pub](https://hub.fabric.pub)** (or a local Hub from **`hub.fabric.pub`** / **`fabric-http`**), or the local harness at **`http://127.0.0.1:3044/test.html`** after `npm run serve:test` (see **Local Extension Test Harness** above).
5. When the wallet has been imported or created, you can toggle and view addresses for the chains you enabled.
6. On Fabric sites, use the app’s own Fabric login / identity flow (and the extension’s **Connect & register** where offered); the Passport popup and content scripts follow the Fabric message and storage contracts used across FabricLabs repos.

### Client-signed site login (Passport ↔ desktop)
Sites that use Hub `POST /sessions` can offer **Sign in with Passport** alongside `fabric://login` (GoonCitizen / Hub desktop). The page `postMessage`s:

```js
window.postMessage({
  source: 'fabric-site',
  type: 'FABRIC_SITE_LOGIN_REQUEST',
  sessionId, hub: location.origin, origin: location.origin, message
}, location.origin);
```

Passport queues the challenge, the popup approves, and POSTs BIP340 `{ signature, pubkeyHex, identity }` to `/sessions/:id/signatures` (same body as GoonCitizen). Poll `GET /sessions/:id` until `status: 'signed'`.

### Mutual device-link (separate seeds)
Hub Identity → **Create link offer** → `fabric://link?…`, or on the Hub page **Approve with Passport**:

```js
window.postMessage({
  source: 'fabric-site',
  type: 'FABRIC_DEVICE_LINK_REQUEST',
  sessionId, hub: location.origin, origin: location.origin
}, location.origin);
```

Passport signs as **responder**; the initiator countersigns. Seeds stay per-app.

## Encryption
Data stored in leveldb is encrypted with the subtleCrypto AES-GCM algorithm. Encryption methods are found in fabric/core/types/subtleCrypto

#### const importKey = ()
- Description : Import Key for SubtleCrypto Encryption

#### const generateKey = ()
- Description : Generate Key for SubtleCrypto Encryption

#### const encrypt = (data, key, iv)
- Description : Encrypt data
- Params
  - {ArrayBuffer} data : Data to be encrypted
  - {CryptoKey} key : Key to be used for encryption
  - {Uint8Array} iv : Initial Vector for encryption

#### const decrypt = (data, key, iv)
- Description : Decrypt data
- Params
  - {ArrayBuffer} data : Data to be decrypted
  - {CryptoKey} key : Key to be used for decryption
  - {Uint8Array} iv : Initial Vector for decryption

#### const encryptToString = (data)
- Description : Encrypt data to string
- Params
  - {ArrayBuffer} data : Data to be encrypted

#### const decryptFromString = (data)
- Description : Decrypt data from string
- Params
  - {String} data : Data to be decrypted

### New Chain Integration
Per-chain derivation and address formatting live in `src/UIElements/IdentityManager.tsx` (BIP32 / bech32 paths). Add shared config there or in a new `src/config/chains.ts` when you formalize multiple chains.

### Storage function descriptions

#### const initDB = async ()
- Description : Initialize leveldb with chain flags set to true

#### const setSeedPhrase = async (phrase)
- Description : Set seed phrase to setting
- Params
  - {Array<string>} phrase : 12 seed phrases

#### const insertAccount = async (account)
- Description : Insert a new account
- Params
  - {object}    account : Account Info

#### const insertIdentity = async (identity, accountId = 0)
- Description : Insert identity into an account
- Params
  - {IIdentity} identity : array of identities generated from account
  - {number}    accountId : index of account generated from seed.

#### const setDBIdentityCheckState = async (accountId, identity, chain, state)
- Description :  Enable/disable chain operability for specified identity
- Params
  - {number} accountId : Account index
  - {number} identity : identity index
  - {number} chain : chain's id listed in browser extension
  - {boolean} state : boolean to enable or disable chain

#### const setGlobalChainState = async (settings)
- Description : Enable/disable chain operability for wallet
- Params
  - {Array} settings : Chain Settings

#### const getAccountValid = async ()
- Description : Check if there is an account in the store

#### const getGlobalChainState = async ()
- Description : Get global chain state

#### const getAccount = async (accountId = 0)
- Description : Get specific account from the store
- Params
  - {number} accountId : Account Index

#### const checkPassword = async (accountId 0, password)
- Description : Check if the password inputed is same as saved in the store
- Params
  - {number} accountId : Account Index
  - {string} passHash : Hashed Password

#### const changePassword = async (accountId = 0, password)
- Description : Change the password in the store
- Params
  - {number} accountId : Account Index
  - {string} password : Hashed Password

#### const retrievePrivateKey = async (accountId = 0)
- Description : Retrieves private key of account in the store
- Params
  - {number} accountId : Account Index

#### const getIdentityCount = async (accountId = 0)
- Description : Get Count of identities of an account
- Params
  - {number} accountId : Account Index

