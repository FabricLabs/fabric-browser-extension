# Outstanding (security-first)
Living queue for this repo. Detail and closed items live in [SECURITY.md](../SECURITY.md); posture, known gaps, and pre-listing recommendations live in [AUDIT.md](../AUDIT.md). Suite march: [@fabric/core `docs/PRODUCTION_MARCH.md`](https://github.com/FabricLabs/fabric/blob/feature/rsi/docs/PRODUCTION_MARCH.md).

**Last reviewed:** 2026-10-25 — lockfile pins core **`984b874ba`** (`FabricLabs/fabric#feature/locks`) / http **`b87b1b0`** (`FabricLabs/fabric-http#feature/fomantic`); the same pair is recorded in [SECURITY.md](../SECURITY.md). `npm run test:unit` is **139 passing** against that core (`FABRIC_CORE=node_modules/@fabric/core`; without it the loaders prefer a sibling `../fabric-clean` checkout). Keep this open until CI is green on that pin set.

**Prior reviews:** 2026-08-31 — CI red on `aa584ae` (`Cannot find module '../contracts/hasRole'` from packaged `@fabric/http`); 2026-08-25 — suite quick-win pass; [AUDIT.md](../AUDIT.md) added; invalid ported match patterns removed. The older pins named there (`88f766c28` / `ca27d14`, `1c3f8d08c` / `bbdb72a`) are superseded.

## Blockers before store / shared-host pairing claims
1. **`https://*/*` host breadth — owner decision required.** `host_permissions`
   **and** `content_scripts.matches` cover every HTTPS origin, injecting
   `content.js` at `document_start` in `all_frames`, while the signing
   allowlist is only `hub.fabric.pub` / `relay.goon.vc` / loopback. That is the
   wallet-extension norm (MetaMask ships `<all_urls>`) and it is what makes
   “log in to any Fabric site” work, but it triggers the *“read and change all
   your data on all websites”* prompt and slower, stricter store review that
   needs a written justification. Options and trade-offs: [AUDIT.md](../AUDIT.md)
   Known gaps #1. **Do not narrow unilaterally** — it breaks arbitrary-site
   login without a runtime prompt.
2. **Page-world 402 fetch patch** — `installFabric402FetchInterceptor` is isolated-world today; page `fetch` is not patched until a MAIN-world injector lands. Hub/UI 402 stays on extension UI prompts.
3. **Hub login/link redeem** — Passport signs client-side; Hub/`@fabric/http` still treat QR `sessionId` as the poll capability. Do not treat Origin headers as possession proof.
4. **Never commit** `assets.pem`, store zips, or unlocked datastores.
5. **Privacy URL** — listing needs `https://hub.fabric.pub/passport-privacy.html` live (copy `store/privacy.html` onto Hub). Copy-paste pack: [`docs/CHROME_WEB_STORE.md`](CHROME_WEB_STORE.md).

## Next slices
- [ ] Bind the background datastore AES key to user unlock.
  `encryptedDatastore.getOrCreateAesKey` stores a self-generated master key
  base64 in `chrome.storage.local` **beside** the ciphertext, so `fabricDsSet`
  is obfuscation not encryption. `setDatastoreMasterKeyFromBytes` is already
  wired through `fabricBackgroundRuntimeMessages.ts` — remaining work is
  calling it post-unlock plus migrating existing records. Wallet seed is *not*
  in this store (popup PBKDF2 200k + AES-GCM path). [AUDIT.md](../AUDIT.md) #2.
- [ ] Confirm whether the shipped webpack bundle actually reaches `elliptic`
  (via `@fabric/http` `crypto-browserify`). `npm audit --omit=dev` is **7 high
  / 4 moderate / 5 low**, all transitive; for a wallet, a reachable `elliptic`
  advisory should be treated as release-blocking rather than noise.
- [ ] Move xpub off Hub `GET /services/bitcoin/xpub…` query strings (needs Hub POST endpoints).
- [x] Pin `@fabric/core` **`984b874ba`** / `@fabric/http` **`b87b1b0`** in `package-lock.json`. Live Hub still **`f63a33f`** until operator redeploy.
- [ ] Keep `src/utils/identityCrossSign.ts` lockstep with `@fabric/core/functions/identityCrossSign` (browser-safe mirror, not a re-export: webpack must not pull Node-only `@fabric/core`).
- [ ] Keep `src/utils/fabricHubAllowlist.ts` lockstep with `@fabric/http/functions/fabricHubAllowlist`.
- [x] Bind device-link `sessionId` into attest messages — device-link v2 with `@fabric/http`; GoonCitizen moved in the same cut. [AUDIT.md](../AUDIT.md) #6.
- [ ] Ship the v2 device-link and `fabric:` site-login changes together with the `@fabric/core` / `@fabric/http` / Hub / GoonCitizen pins that carry them — an older Hub answers the v1 one-step offer and Passport now refuses it.
- [ ] Open a `feature/rsi` PR against FabricLabs when this cut is pushed — **[PR #3](https://github.com/FabricLabs/fabric-browser-extension/pull/3) is `eric/develop`**, not this work.

## Closed / in this cut
- **Local-first `fabric:` sign-in.** Pages post a `fabric:` `SiteLoginRequest`; Passport binds it to the origin Chrome reports and answers as Passport or as a linked desktop (Hub / GoonCitizen `POST /services/fabric/sign`, native approval on the desktop). Popup: `SiteLoginPrompt` identity picker, **Desktop apps** panel (discover, link with `POST /services/fabric/link`), **Trusted hubs** panel. `tests/fabricSiteMessage.unit.ts`. See [SECURITY.md](../SECURITY.md#local-first-fabric-sign-in).
- **Allowlist + manifest.** `https://hub.goon.vc` in the default allowlist; `http://[::1]/*` alongside the other loopback twins; `optional_host_permissions: ["http://*/*"]` for LAN hubs the user trusts (granted per host on Save). `FABRIC_HUB_REGISTER_MESH` requires sender origin === hub.
- **Auto-lock activity timestamps reject epoch 0.** `touchFabricActivity` /
  `readFabricActivityMs` require a positive epoch ms (same guard as suite chat
  `created` stamps) so `0` / negative stored values do not bypass idle lock.
  `tests/fabricActivityStorage.unit.ts`.
- **Unit runner invokes mocha via `node`.** `npm run test:unit` /
  `test:extension` call `node ./node_modules/mocha/bin/mocha.js` — the `.bin`
  shim is not executable in some installs (`Permission denied`).
- **Manifest match patterns are Web-Store-valid.** Dropped 108 lines of
  `http://localhost:<port>/*` / `http://127.0.0.1:<port>/*` entries from
  `host_permissions` and `content_scripts.matches`. Chrome match patterns
  cannot express a port; the port-less twins `http://localhost/*` /
  `http://127.0.0.1/*` were already first in both lists and match **every**
  port, so no permission was broadened or narrowed. Chrome is lenient at load
  time but the Web Store validator rejects the upload, so this was a latent
  submission blocker. `tests/chromeStoreListing.unit.ts` now asserts that no
  pattern in `host_permissions` / `content_scripts` / `web_accessible_resources`
  carries a port (`:<n>` or `:*`) and that both loopback twins survive, so a
  port cannot regress into the next upload. Built copy `assets/manifest.json`
  re-synced; `npm run build` clean.
- **[AUDIT.md](../AUDIT.md) added** — posture table, ten known gaps, the
  intentional browser-safe duplicate list (`identityCrossSign.ts`,
  `fabricHubAllowlist.ts` — drift is the bug, not duplication), and pre-listing
  recommendations. Matches the shape of the `@fabric/core` / `@fabric/http` /
  `@fabric/hub` audit documents; [SECURITY.md](../SECURITY.md) links it.
- Chrome Web Store listing pack: `docs/CHROME_WEB_STORE.md`, `docs/privacy-policy.md`, `store/privacy.html`, `npm run store:assets` (icons / promo / 1280×800 boards). Hub copy: `hub.fabric.pub/assets/passport-privacy.html` (deploy for the listing URL). Manifest display name **Fabric Passport**; unused `scripting` / `activeTab` dropped; Bitcoin RPC / Ollama loopback hosts dropped.
- Device-link initiator + responder; IdentityCrossSign publish/revoke; linked-device roster.
- LiveRelay interop (`tests/passportGooncitizenLink.unit.ts`): Passport client against GoonCitizen `/device-links` (hosted hub + Android local accept) and IdentityCrossSign HTTP. Skip when sibling `~/star-citizen-live` cannot load.
- chrome-extension / moz-extension Origins accepted by Hub http thin-client gate on allowlisted hubs.
- HTTPS-only default hub allowlist; phishing origins refused in `tests/adversarialEnvironment.basics.unit.ts`.
- Unit coverage for the full device-link HTTP flow (offer → accept → countersign → cross-sign → revoke), ARC publish/withdrawal evaluation, and Bitcoin `sendrawtransaction` / faucet failure modes.
- IdentityCrossSign TS helper is a browser-safe mirror of `@fabric/core` (introduced at core `88f766c28`: `_normPubkey` rejects colon-smashed / non-hex keys; unknown `kind` rejected; truncated identity-id hex throws; `fabricIdentityAccountPath` exported). Device-link HTTP omits client-set Origin/Referer (Hub accepts `chrome-extension:` / `moz-extension:` on allowlisted hubs). May CodeRabbit notes on PR #3 (`eric/develop`) — invalid derive index, balance NaN, 402 `ln` trim, activity timestamps, harness `:3044`, exact 32-byte master key (`tests/encryptedDatastore.unit.ts`) — are already on **this** `feature/rsi` tip. CI uses `.nvmrc` **26.12.1** (was hardcoded Node 22).

## PRs
No human review comments on PR #3. Do not merge or retarget that branch as the RSI deploy. April–May CodeRabbit “quick wins” on `eric/develop` are already on `feature/rsi` (see Closed). **Tests and coverage** on GitHub PR #3 (`eric/develop` @ `51ea3c3`, 2026-08-12) fails: Playwright headless-shell cannot discover the MV3 service worker (`Could not find chrome-extension:// service worker`). This tree stages headed Chromium + `xvfb-run` + `PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL=0`. Codacy ACTION_REQUIRED on that PR; `.codacy.yml` excludes generated trees (Hub-style). Pin core **`984b874ba`** / http **`b87b1b0`**. Do not retarget [#3](https://github.com/FabricLabs/fabric-browser-extension/pull/3). Keep `report:install` lockfile wipe (suite RSI convention; script now `rm -f` instead of writing a blank line).
