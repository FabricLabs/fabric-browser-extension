# Outstanding (security-first)
Living queue for this repo. Detail and closed items live in [SECURITY.md](../SECURITY.md); posture, known gaps, and pre-listing recommendations live in [AUDIT.md](../AUDIT.md). Suite march: [@fabric/core `docs/PRODUCTION_MARCH.md`](https://github.com/FabricLabs/fabric/blob/feature/rsi/docs/PRODUCTION_MARCH.md).

**Last reviewed:** 2026-08-25 — suite quick-win pass. `npm run test:unit` **94 passing**; `npm run build` clean. Added [AUDIT.md](../AUDIT.md) (this repo was the only one of the five without one). Removed 108 invalid ported match patterns from the manifest (Web Store validator blocker — see Closed).

**Prior review:** 2026-08-20 (`feature/rsi`; core lockfile `9938917`, http lockfile `7d7f1c7`; next core pin [@fabric/core #186](https://github.com/FabricLabs/fabric/pull/186) HEAD **`9c6ade0`**). Device-link `cancelDeviceLinkSession` fetch rejection is `ok: false` (aligned with http [#69](https://github.com/FabricLabs/fabric-http/pull/69) CodeRabbit). Hub copy `assets/passport-privacy.html` is in the Hub tree — production URL still needs deploy ([crash scan](https://relay.goon.vc/downstream.agents.md) does not cover this).

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
- [ ] Pin `@fabric/core` after [#186](https://github.com/FabricLabs/fabric/pull/186) lands (handshake-bus + gossip catalog; HEAD **`9c6ade0`**). Live Hub still **`f63a33f`**.
- [ ] Keep `src/utils/identityCrossSign.ts` lockstep with `@fabric/core/functions/identityCrossSign` (TS re-export; webpack must not pull Hub Node).
- [ ] Keep `src/utils/fabricHubAllowlist.ts` lockstep with `@fabric/http/functions/fabricHubAllowlist`.
- [ ] Bind device-link `sessionId` into attest messages when http/Hub land that protocol bump.
- [ ] Open a `feature/rsi` PR against FabricLabs when this cut is pushed — **[PR #3](https://github.com/FabricLabs/fabric-browser-extension/pull/3) is `eric/develop`**, not this work.

## Closed / in this cut
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
- **[AUDIT.md](../AUDIT.md) added** — posture table, nine known gaps, the
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
- IdentityCrossSign TS helper re-exports `@fabric/core` (lockfile `9938917`: `_normPubkey` rejects colon-smashed / non-hex keys; unknown `kind` rejected; truncated identity-id hex throws; `fabricIdentityAccountPath` exported). Device-link HTTP omits client-set Origin/Referer (Hub accepts `chrome-extension:` / `moz-extension:` on allowlisted hubs). May CodeRabbit notes on PR #3 (`eric/develop`) — invalid derive index, balance NaN, 402 `ln` trim, activity timestamps, harness `:3044`, exact 32-byte master key (`tests/encryptedDatastore.unit.ts`) — are already on **this** `feature/rsi` tip. CI uses `.nvmrc` **24.15.0** (was hardcoded Node 22).

## PRs
No human review comments on PR #3. Do not merge or retarget that branch as the RSI deploy. April–May CodeRabbit “quick wins” on `eric/develop` are already on `feature/rsi` (see Closed). **Tests and coverage** on GitHub PR #3 (`eric/develop` @ `51ea3c3`, 2026-08-12) fails: Playwright headless-shell cannot discover the MV3 service worker (`Could not find chrome-extension:// service worker`). This tree stages headed Chromium + `xvfb-run` + `PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL=0`. Codacy ACTION_REQUIRED on that PR; `.codacy.yml` excludes generated trees (Hub-style). Pin core **`9938917`** / http **`7d7f1c7`** (next core [#186](https://github.com/FabricLabs/fabric/pull/186) HEAD **`9c6ade0`**). Do not retarget [#3](https://github.com/FabricLabs/fabric-browser-extension/pull/3). Keep `report:install` lockfile wipe (suite RSI convention; script now `rm -f` instead of writing a blank line).
