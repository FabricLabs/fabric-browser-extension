# Outstanding (security-first)
Living queue for this repo. Detail and closed items live in [SECURITY.md](../SECURITY.md). Suite march: [@fabric/core `docs/PRODUCTION_MARCH.md`](https://github.com/FabricLabs/fabric/blob/feature/rsi/docs/PRODUCTION_MARCH.md).

**Last reviewed:** 2026-08-16 (`security/adversarial-quick-wins`; core lockfile `f1b5e147`, http lockfile `1b162e35`). Device-link `cancelDeviceLinkSession` fetch rejection is `ok: false` (aligned with http [#69](https://github.com/FabricLabs/fabric-http/pull/69) CodeRabbit). Hub copy `assets/passport-privacy.html` is in the Hub tree — production URL still needs deploy ([crash scan](https://relay.goon.vc/downstream.agents.md) does not cover this).

## Blockers before store / shared-host pairing claims
1. **Page-world 402 fetch patch** — `installFabric402FetchInterceptor` is isolated-world today; page `fetch` is not patched until a MAIN-world injector lands. Hub/UI 402 stays on extension UI prompts.
2. **Hub login/link redeem** — Passport signs client-side; Hub/`@fabric/http` still treat QR `sessionId` as the poll capability. Do not treat Origin headers as possession proof.
3. **Never commit** `assets.pem`, store zips, or unlocked datastores.
4. **Privacy URL** — listing needs `https://hub.fabric.pub/passport-privacy.html` live (copy `store/privacy.html` onto Hub). Copy-paste pack: [`docs/CHROME_WEB_STORE.md`](CHROME_WEB_STORE.md).

## Next slices
- [ ] Move xpub off Hub `GET /services/bitcoin/xpub…` query strings (needs Hub POST endpoints).
- [ ] Keep `src/utils/identityCrossSign.ts` lockstep with `@fabric/core/functions/identityCrossSign` (TS re-export; webpack must not pull Hub Node).
- [ ] Keep `src/utils/fabricHubAllowlist.ts` lockstep with `@fabric/http/functions/fabricHubAllowlist`.
- [ ] Bind device-link `sessionId` into attest messages when http/Hub land that protocol bump.
- [ ] Open a `feature/rsi` PR against FabricLabs when this cut is pushed — **[PR #3](https://github.com/FabricLabs/fabric-browser-extension/pull/3) is `eric/develop`**, not this work.

## Closed / in this cut
- Chrome Web Store listing pack: `docs/CHROME_WEB_STORE.md`, `docs/privacy-policy.md`, `store/privacy.html`, `npm run store:assets` (icons / promo / 1280×800 boards). Hub copy: `hub.fabric.pub/assets/passport-privacy.html` (deploy for the listing URL). Manifest display name **Fabric Passport**; unused `scripting` / `activeTab` dropped; Bitcoin RPC / Ollama loopback hosts dropped.
- Device-link initiator + responder; IdentityCrossSign publish/revoke; linked-device roster.
- LiveRelay interop (`tests/passportGooncitizenLink.unit.ts`): Passport client against GoonCitizen `/device-links` (hosted hub + Android local accept) and IdentityCrossSign HTTP. Skip when sibling `~/star-citizen-live` cannot load.
- chrome-extension / moz-extension Origins accepted by Hub http thin-client gate on allowlisted hubs.
- HTTPS-only default hub allowlist; phishing origins refused in `tests/adversarialEnvironment.basics.unit.ts`.
- Unit coverage for the full device-link HTTP flow (offer → accept → countersign → cross-sign → revoke), ARC publish/withdrawal evaluation, and Bitcoin `sendrawtransaction` / faucet failure modes.
- IdentityCrossSign TS helper re-exports `@fabric/core` (lockfile `f1b5e147`: `_normPubkey` rejects colon-smashed / non-hex keys; unknown `kind` rejected; truncated identity-id hex throws; `fabricIdentityAccountPath` exported). Device-link HTTP omits client-set Origin/Referer (Hub accepts `chrome-extension:` / `moz-extension:` on allowlisted hubs). May CodeRabbit notes on PR #3 (`eric/develop`) — invalid derive index, balance NaN, 402 `ln` trim, activity timestamps, harness `:3044`, exact 32-byte master key (`tests/encryptedDatastore.unit.ts`) — are already on **this** `feature/rsi` tip. CI uses `.nvmrc` **24.15.0** (was hardcoded Node 22).

## PRs
No human review comments on PR #3. Do not merge or retarget that branch as the RSI deploy. April–May CodeRabbit “quick wins” on `eric/develop` are already on `feature/rsi` (see Closed). **Tests and coverage** on GitHub PR #3 (`eric/develop`) still uses Playwright headless-shell; this tree stages headed Chromium + `xvfb-run` + `PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL=0`. Codacy 605-issue cap: `.codacy.yml` excludes generated trees (Hub-style) plus unused `FABRIC_STATE_STORAGE_KEY` import. Pin core **`f1b5e147`** / http **`1b162e35`**. Do not retarget [#3](https://github.com/FabricLabs/fabric-browser-extension/pull/3).
