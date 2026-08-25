# Audit notes — `@fabric/passport`

Living list of **known issues, accepted risks, and recommendations** for the
browser extension. This is an internal posture document, not a third-party
audit report. Detail and closed items live in [SECURITY.md](SECURITY.md); the
working queue is [docs/OUTSTANDING.md](docs/OUTSTANDING.md).

Peer documents: [`@fabric/core` AUDIT.md](https://github.com/FabricLabs/fabric/blob/feature/rsi/AUDIT.md),
[`@fabric/http` AUDIT.md](https://github.com/FabricLabs/fabric-http/blob/feature/rsi/AUDIT.md),
[`@fabric/hub` AUDIT.md](https://github.com/FabricLabs/hub.fabric.pub/blob/feature/rsi/AUDIT.md).

## Status (2026-08-24)

| Area | Posture |
|------|---------|
| Manifest | **MV3**, `minimum_chrome_version` 109. Permissions: `storage`, `tabs`, `notifications`, `offscreen`, `alarms`, `webRequest`, `declarativeNetRequest`. Unused `scripting` / `activeTab` dropped |
| Match-pattern validity | **Fixed** — no `host_permissions` / `content_scripts` / `web_accessible_resources` pattern carries an explicit port. Chrome match patterns cannot express a port and the Web Store validator rejects the upload even though Chrome is lenient at load; `http://localhost/*` + `http://127.0.0.1/*` already match every port. Regression guard: `tests/chromeStoreListing.unit.ts` |
| Host breadth | **Accepted risk, store-review relevant** — `https://*/*` in `host_permissions` **and** `content_scripts.matches` (`document_start`, `all_frames`). See Known gaps #1 |
| Hub trust boundary | Allowlist is `https://hub.fabric.pub`, `https://relay.goon.vc`, plus loopback (`src/utils/fabricHubAllowlist.ts`, lockstep with `@fabric/http/functions/fabricHubAllowlist`). Cleartext network hubs require `opts.extra`. Non-allowlisted origins are refused for site-login / device-link signing |
| Identity signing | BIP340 Schnorr client-side; site-login and device-link challenges are built by the shared upstream helpers, never by the page |
| Wallet at rest | **PBKDF2-SHA256, 200 000 iterations, 32-byte key + AES-GCM** for backup export/import (`src/UIElements/IdentityManager.tsx`) |
| Background datastore at rest | **Weak by default** — AES-GCM with a self-generated master key stored *in plaintext beside the ciphertext* in `chrome.storage.local`. See Known gaps #2 |
| Content-script trust | Content scripts are untrusted relative to the background; seed material never leaves the background / popup |
| CSP | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` — no remote code |
| Unit tests | **94 passing** (`npm run test:unit`) — device-link flow, cross-sign, allowlist, ARC publish/evaluate, encrypted datastore, activity auto-lock timestamps, adversarial origins, store listing |
| Extension E2E | Playwright MV3 (`npm run test:extension`, `npm run test:ui`). Headless-shell cannot discover the MV3 service worker; this tree stages headed Chromium + `xvfb-run` |
| JSON-RPC auth gate | `npm run test:ui:release-gate` — bearer + `POST /services/rpc` per [`@fabric/http` docs/RELEASE_GATE.md](https://github.com/FabricLabs/fabric-http/blob/feature/rsi/docs/RELEASE_GATE.md) |
| npm audit (`--omit=dev`) | **16 findings (7 high / 4 moderate / 5 low)** — all transitive. See Known gaps #3 |
| External security review | **Outstanding** before dropping “experimental” language |
| Store listing pack | Complete — [`docs/CHROME_WEB_STORE.md`](docs/CHROME_WEB_STORE.md), [`docs/privacy-policy.md`](docs/privacy-policy.md), `store/` icons + promo + 1280×800 screenshots. **Blocked on ops:** the listing privacy URL `https://hub.fabric.pub/passport-privacy.html` is not deployed |

## Known gaps (do not paper over)

1. **`https://*/*` host breadth is a product decision, not an oversight.** The
   extension injects `js/content.js` at `document_start` into `all_frames` of
   every HTTPS origin, and holds host permissions for the same. That is the
   wallet-extension norm (MetaMask ships `<all_urls>`) and it is what lets any
   Fabric site offer `fabric://login`. The costs are real and should be
   accepted deliberately rather than by default:
   - the install prompt reads *“Read and change all your data on all websites”*;
   - Chrome Web Store review is slower and stricter for broad host access, and
     needs a written justification in the listing;
   - the injected surface is far wider than the two origins the code actually
     trusts for signing.
   Options, cheapest first: (a) keep it and justify in the listing; (b) narrow
   `content_scripts` to the allowlisted hubs and move general-site detection to
   `optional_host_permissions` requested on user gesture; (c) keep broad
   injection but ship `contentMarker` only, deferring `content.js` to an
   `optional_host_permissions` grant. **Owner decision required** — do not
   change unilaterally, it is a UX/product trade, and (b)/(c) break
   “log in to any Fabric site” without a runtime prompt.
2. **Background datastore master key is not password-bound.**
   `src/background/encryptedDatastore.ts` `getOrCreateAesKey` generates a random
   32-byte key and persists it base64 in `chrome.storage.local` next to the
   ciphertext, so `fabricDsSet` is obfuscation — not encryption — against an
   attacker who can read extension storage. The module docstring says as much.
   Mitigating facts: the store is documented for “mesh metadata, counters,
   non-wallet secrets”; the **wallet seed does not live here** (that is the
   popup PBKDF2 + AES-GCM path); and
   `setDatastoreMasterKeyFromBytes` is already wired through
   `fabricBackgroundRuntimeMessages.ts` so a post-unlock key can replace it.
   Remaining work is to actually call it after unlock and to migrate existing
   records. Parallels Hub `docs/OUTSTANDING.md` blocker #3 (at-rest identity KDF).
3. **`npm audit --omit=dev` is not clean (7 high).** All findings are
   transitive, none are direct dependencies:
   - `elliptic`, `browserify-sign`, `create-ecdh`, `crypto-browserify` — pulled
     in by `@fabric/http` for browser crypto polyfills. Worth confirming
     whether the webpack build actually reaches `elliptic` code paths, since
     this is a wallet.
   - `uuid` via `jayson` via `@fabric/core` — core mitigates with an
     `uuid@11.1.1` override; Passport should inherit it after the next pin.
   - `puppeteer` / `@puppeteer/browsers` / `extract-zip` — a **production**
     dependency of `@fabric/http` (its Sandbox), not of the shipped extension
     bundle. `@fabric/http` tracks a deferred `puppeteer@25.7.0` bump.
   - `@babel/core`, `webpack`, `valibot`, `bip32` — build/toolchain trees.
   Prefer upstream bumps and explicit overrides over `npm audit fix --force`.
   Re-check after each Fabric pin bump.
4. **Page-world 402 fetch patch is not installed.**
   `installFabric402FetchInterceptor` runs in the isolated content-script world
   because login / device-link messaging needs that world; page `fetch` is
   therefore unpatched. Hub/UI 402 stays on extension UI prompts. The module
   `src/content/fabric402FetchPatch.ts` exists — the limit is world isolation,
   not a missing file.
5. **xpub travels in query strings.** Wallet balance / history call Hub
   `GET /services/bitcoin/xpub…`. Moving the xpub into POST bodies needs
   coordinated Hub endpoints, so this is cross-repo work.
6. **Device-link `sessionId` is not bound into attest messages.** A captured
   responder signature + initiator countersignature can be replayed into a new
   session id. Upstream detail and the coordinated fix live in
   [`@fabric/http` docs/OUTSTANDING.md](https://github.com/FabricLabs/fabric-http/blob/feature/rsi/docs/OUTSTANDING.md);
   Passport must bump in lockstep, not ahead.
7. **Hub login redeem treats QR `sessionId` as the capability.** Passport signs
   client-side, but possession proof is upstream (`pollSecret`, http `#69`).
   Do not treat `Origin` headers as possession proof.
8. **MV3 service worker lifecycle.** Long-lived mesh state must survive worker
   suspension; `alarms` + the offscreen document cover the current paths, but
   there is no systematic test that state survives a forced worker teardown.
9. **`webRequest` / `declarativeNetRequest` are declared for identity outband
   header rules.** Rule IDs and handlers must stay in sync when outband
   behaviour changes; both permissions widen the review surface.

## Intentional duplicates (not consolidation targets)

- `src/utils/identityCrossSign.ts` re-implements the canonical strings from
  `@fabric/core/functions/identityCrossSign` in TypeScript **on purpose** so
  webpack does not pull Node-only `@fabric/core` into the extension bundle.
  Kept lockstep by `tests/identityCrossSign.unit.ts`.
- `src/utils/fabricHubAllowlist.ts` mirrors
  `@fabric/http/functions/fabricHubAllowlist` for the same reason. The
  extension additionally cannot read `FABRIC_HUB_ALLOWLIST` from `process.env`
  at build time.

Changing either to a runtime `require` of the upstream package would regress
bundle size and pull Node built-ins — treat drift, not duplication, as the bug.

## Recommendations before a public store listing

- [ ] **Owner decision on Known gaps #1** (`https://*/*`) and, if kept, write
      the broad-host justification into the store listing form
- [ ] Deploy `https://hub.fabric.pub/passport-privacy.html` (source:
      `store/privacy.html`) — the listing cannot be submitted without a live
      privacy URL
- [ ] Bind the background datastore key to user unlock (Known gaps #2)
- [ ] Confirm whether the shipped bundle reaches `elliptic`; if so, treat the
      advisory as release-blocking rather than transitive noise
- [ ] `npm run test:all` plus `npm run test:ui:release-gate` on a clean tree
- [ ] Re-pin `@fabric/core` / `@fabric/http` to the tagged suite SHAs and
      re-run `npm audit --omit=dev`
- [ ] Keep the release claim scoped: browser identity + site login +
      device link — **not** an audited hardware-grade wallet

## Disclosure

Canonical monitored contact: **`security@fabric.pub`**. GitHub Security
Advisories are the alternate private channel. See [SECURITY.md](SECURITY.md).
