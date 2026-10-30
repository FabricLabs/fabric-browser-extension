# Audit notes — `@fabric/passport`

Living list of **known issues, accepted risks, and recommendations** for the
browser extension. This is an internal posture document, not a third-party
audit report. Detail and closed items live in [SECURITY.md](SECURITY.md); the
working queue is [docs/OUTSTANDING.md](docs/OUTSTANDING.md).

Peer documents: [`@fabric/core` AUDIT.md](https://github.com/FabricLabs/fabric/blob/feature/rsi/AUDIT.md),
[`@fabric/http` AUDIT.md](https://github.com/FabricLabs/fabric-http/blob/feature/rsi/AUDIT.md),
[`@fabric/hub` AUDIT.md](https://github.com/FabricLabs/hub.fabric.pub/blob/feature/rsi/AUDIT.md).

## Status (2026-10-30)

| Area | Posture |
|------|---------|
| Manifest | **MV3**, `minimum_chrome_version` 109. Permissions: `storage`, `tabs`, `notifications`, `offscreen`, `alarms`, `webRequest`, `webNavigation`, `idle`, `declarativeNetRequest`. Unused `scripting` / `activeTab` dropped |
| Match-pattern validity | **Fixed** — no `host_permissions` / `content_scripts` / `web_accessible_resources` pattern carries an explicit port. Chrome match patterns cannot express a port and the Web Store validator rejects the upload even though Chrome is lenient at load; `http://localhost/*` + `http://127.0.0.1/*` already match every port. Regression guard: `tests/chromeStoreListing.unit.ts` |
| Host breadth | **Accepted risk, store-review relevant** — `https://*/*` in `host_permissions` **and** `content_scripts.matches` (`document_start`, `all_frames`). See Known gaps #1 |
| Hub trust boundary | Allowlist is `https://hub.fabric.pub`, `https://relay.goon.vc`, `https://hub.goon.vc`, plus loopback (`src/utils/fabricHubAllowlist.ts`, lockstep with `@fabric/http/functions/fabricHubAllowlist`). Users add more under **Trusted hubs**, stored in extension-origin IndexedDB (`src/utils/privateStore.ts`); a LAN `http://` hub also needs a runtime host grant (`optional_host_permissions` `http://*/*`, requested on the Save click). Cleartext network hubs require `opts.extra`. The Trusted hubs list carries an HMAC keyed from the unlocked master (locked = empty). Non-allowlisted origins are refused for pairing, delegation mail, and mesh registration (`FABRIC_HUB_REGISTER_MESH` also requires the sending tab to *be* that hub) |
| Identity signing | BIP340 Schnorr client-side; sign-in assertions and delegation frames are built by the `@fabric/core` helpers from what the browser reports, never from page fields |
| Site sign-in (Passport v2) | Any HTTPS or loopback page may ask Passport to sign in to **itself**: it posts a `PASSPORT_CHALLENGE` with a `MessagePort` after a `PASSPORT_HELLO` handshake (nothing is marked on the page, and the content script does not log). The content script forwards it only while `navigator.userActivation.isActive`. The background binds it to the origin Chrome reports, walks frame ancestors, allows one per origin at a time, rate-limits the notification, and answers only on that port. A new site gets a pairwise identity by default; the prompt names that choice. The shared account key is the opt-in |
| Linked signers | Delegation protocol on Fabric messages (`DELEGATION_*`, core `docs/DELEGATION.md`): commit-then-reveal pairing with a six-digit code, scoped and revocable grants, and every `DELEGATION_REQUEST` shown as a notification for the user to sign or decline. Records carry an HMAC keyed from the master |
| Wallet at rest | Master xprv sealed with **Argon2id (64 MiB, t=2, p=1) + AES-GCM** when the linked core's `sealMaster` reports `ARGON2_MASTER` (core `sealedBlob`); an older PBKDF2 seal is re-sealed on the next unlock. The lock password is at least 12 characters. Cached public keys are checked against the master on unlock, and a locked popup does not derive a receive address. The vault, signed-in sites, delegate bases, and trust lists live in extension-origin IndexedDB. Auto-lock runs from `chrome.alarms` and from `chrome.idle` state `locked` |
| Background datastore at rest | **Weak by default** — AES-GCM with a self-generated master key stored *in plaintext beside the ciphertext* in `chrome.storage.local`. See Known gaps #2 |
| Content-script trust | Content scripts are untrusted relative to the background; seed material never leaves the background / popup |
| CSP | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` — no remote code |
| Unit tests | **154 passing** (`npm run test:unit`) — Passport v2 sign-in, delegation (pairing, grants, requests), payment requests, sealed trusted lists, vault re-seal and cache checks, allowlist, ARC publish/evaluate, encrypted datastore, activity auto-lock timestamps, adversarial origins, store listing |
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
   Fabric site offer Passport sign-in. The costs are real and should be
   accepted deliberately rather than by default:
   - the install prompt reads *“Read and change all your data on all websites”*;
   - Chrome Web Store review is slower and stricter for broad host access, and
     needs a written justification in the listing;
   - the injected surface is far wider than the two origins the code actually
     trusts for signing.
   Options, cheapest first: (a) keep it and justify in the listing; (b) narrow
   `content_scripts` to the allowlisted hubs and move general-site detection to
   `optional_host_permissions` requested on user gesture; (c) keep broad
   injection of a minimal script that only answers `PASSPORT_HELLO`, deferring
   `content.js` to an `optional_host_permissions` grant. **Owner decision required** — do not
   change unilaterally, it is a UX/product trade, and (b)/(c) break
   “log in to any Fabric site” without a runtime prompt.
2. **Background datastore master key is not password-bound.**
   `src/background/encryptedDatastore.ts` `getOrCreateAesKey` generates a random
   32-byte key and persists it base64 in `chrome.storage.local` next to the
   ciphertext, so `fabricDsSet` is obfuscation — not encryption — against an
   attacker who can read extension storage. The module docstring says as much.
   Mitigating facts: the store is documented for “mesh metadata, counters,
   non-wallet secrets”; the **wallet seed does not live here** (that is the
   popup Argon2id + AES-GCM path, PBKDF2 until the linked core sets `ARGON2_MASTER`); and
   `setDatastoreMasterKeyFromBytes` is already wired through
   `fabricBackgroundRuntimeMessages.ts` so a post-unlock key can replace it.
   Remaining work is to actually call it after unlock and to migrate existing
   records. Parallels Hub `docs/OUTSTANDING.md` blocker #3 (at-rest identity KDF).
3. **`npm audit --omit=dev` is not clean (7 high).** All findings are
   transitive, none are direct dependencies:
   - `elliptic`, `browserify-sign`, `create-ecdh`, `crypto-browserify` —
     removed. Webpack maps `crypto` to `@fabric/http/functions/browserCrypto`
     (noble hashes and ciphers), and none of these packages is bundled. They
     leave the lockfile once it resolves an `@fabric/http` that ships that file.
   - `uuid` via `jayson` via `@fabric/core` — core mitigates with an
     `uuid@11.1.1` override; Passport should inherit it after the next pin.
   - `puppeteer` / `@puppeteer/browsers` / `extract-zip` — a **production**
     dependency of `@fabric/http` (its Sandbox), not of the shipped extension
     bundle. `@fabric/http` tracks a deferred `puppeteer@25.7.0` bump.
   - `@babel/core`, `webpack`, `valibot`, `bip32` — build/toolchain trees.
   Prefer upstream bumps and explicit overrides over `npm audit fix --force`.
   This cut accepts those build-time findings and does not rewrite the lockfile.
   Re-check after each Fabric pin bump.
4. **Page-world 402 fetch patch is not installed.**
   `installFabric402FetchInterceptor` runs in the isolated content-script world
   because sign-in messaging needs that world; page `fetch` is therefore
   unpatched. A 402 it does see is only reported to the background, which
   queues it and shows it in the popup (no in-page overlay).
5. **xpub travels in query strings.** Wallet balance / history call Hub
   `GET /services/bitcoin/xpub…`. Moving the xpub into POST bodies needs
   coordinated Hub endpoints, so this is cross-repo work.
6. ~~**Device-link `sessionId` is not bound into attest messages.**~~ **Closed**
   and superseded: device links, desktop signers, and `IdentityCrossSign` are
   gone. Linking is the delegation protocol's offer / answer / reveal, where
   each side commits its nonce before the code exists.
7. ~~**Hub login redeem treats QR `sessionId` as the capability.**~~ **Closed.**
   Passport v2 has no QR session and no `pollSecret`. A relying party issues a
   `PASSPORT_CHALLENGE`, Passport returns a `PASSPORT_ASSERTION` on the page's
   `MessagePort`, and the server redeems it with the binding secret from the
   HttpOnly cookie. `Origin` is not possession proof; the signature and the
   cookie are.
8. **MV3 service worker lifecycle.** Long-lived mesh state must survive worker
   suspension; `alarms` + the offscreen document cover the current paths, but
   there is no systematic test that state survives a forced worker teardown.
9. **`webRequest` / `declarativeNetRequest` are declared for identity outband
   header rules.** Rule IDs and handlers must stay in sync when outband
   behaviour changes; both permissions widen the review surface.

10. **Other extensions can reach a loopback delegate.** Hub and GoonCitizen
   answer `/services/delegation/*` on loopback to Passport. Chrome extension
   ids stay on the configured allowlist. A `moz-extension://` origin may start
   pairing, and the first grant pins that exact origin; a later Firefox id is
   refused until the user pairs again. Every request must still be a frame
   signed by a linked key within its grant, and pairing needs the user to
   confirm the code on both sides.
11. ~~**The active Fabric node setting is not sealed.**~~ The vault and the
   active-node record moved to extension-origin IndexedDB with the trust
   lists. Payment still needs a click in the popup. The background datastore
   key in gap 2 is the record that is still stored beside its ciphertext.

## Intentional duplicates (not consolidation targets)

- `src/utils/fabricHubAllowlist.ts` mirrors
  `@fabric/http/functions/fabricHubAllowlist` for the same reason. The
  extension additionally cannot read `FABRIC_HUB_ALLOWLIST` from `process.env`
  at build time.

Changing it to a runtime `require` of the upstream package would regress
bundle size and pull Node built-ins — treat drift, not duplication, as the bug.

## Recommendations before a public store listing

- [ ] **Owner decision on Known gaps #1** (`https://*/*`) and, if kept, write
      the broad-host justification into the store listing form
- [ ] Deploy `https://hub.fabric.pub/passport-privacy.html` (source:
      `store/privacy.html`) — the listing cannot be submitted without a live
      privacy URL
- [ ] Bind the background datastore key to user unlock (Known gaps #2)
- [x] Confirm whether the shipped bundle reaches `elliptic` — it no longer
      can: `crypto-browserify` is gone and no `elliptic` module is bundled
- [ ] `npm run test:all` plus `npm run test:ui:release-gate` on a clean tree
- [ ] Re-pin `@fabric/core` / `@fabric/http` to the tagged suite SHAs and
      re-run `npm audit --omit=dev`
- [ ] Keep the release claim scoped: browser identity + site login +
      linked signers — **not** an audited hardware-grade wallet

## Disclosure

Canonical monitored contact: **`security@fabric.pub`**. GitHub Security
Advisories are the alternate private channel. See [SECURITY.md](SECURITY.md).
