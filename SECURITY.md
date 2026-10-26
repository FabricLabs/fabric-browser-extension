# Security (Fabric Passport / browser extension)
Browser wallet and identity extension for Fabric site login and mesh participation.

**Outstanding queue:** [docs/OUTSTANDING.md](docs/OUTSTANDING.md).
**Posture, known gaps, and release recommendations:** [AUDIT.md](AUDIT.md).

## Adversarial environment
Fabric networks are intended for deployment where **peers, relays, hubs, and operators may be hostile**. Design and review against:

- Untrusted TCP (Transmission Control Protocol) / WebSocket / WebRTC neighbors (forgery, replay, amplification, pin hijack)
- Phishing of identity flows (sign-in, device-link) toward attacker-controlled sites and hubs
- Public observability of unsigned or plaintext application traffic unless an explicit seal is used
- No reliance on an “honest majority” of random internet peers for key custody

The extension refuses device-link completions for non-allowlisted Hub origins. Passport keeps only the master xprv, sealed under the lock password; while unlocked it sits in `chrome.storage.session` (trusted contexts only) and is cleared on lock. Content scripts are untrusted relative to the background.

## Passport v2 sign-in
Pages, Passport, and the desktop apps exchange canonical `fabric:<frame>` strings (whole signed AMP frames, checked with `@fabric/core` `decodeFabricUri`). Types: `PASSPORT_CHALLENGE` 0x4240, `PASSPORT_ASSERTION` 0x4241, `PASSPORT_SIGN_REQUEST` 0x4242. Spec: `@fabric/core` `docs/PASSPORT.md`.

- **Origin comes from the browser.** The content script forwards `PASSPORT_CHALLENGE` posts with the page's `MessagePort`; the background binds the challenge to `sender.origin` / `sender.url`, never to a field the page wrote, and refuses one naming another origin. Only HTTPS and loopback origins may ask, only the top page or a same-origin frame, one challenge per tab and frame, each nonce once. The answer goes back to that frame's port only.
- **Nothing extra without consent.** The assertion carries the identity key of the account the user picked. Wallet xpubs and the cosigner key go only when the site asked and the user ticked them.
- **The user picks the account and network** in the popup: Passport signs directly, or asks a linked desktop. A desktop's answer must be signed by the key pinned when it was linked (after both sides showed the same pairing code), on its own network, naming the Passport account that linked it.
- **Desktop signers** (Hub on 8080, GoonCitizen on 3041, or bases the user adds) are loopback only. They answer `GET /services/fabric/identity` and `POST /services/fabric/sign` (a `PASSPORT_SIGN_REQUEST`) only to a loopback socket with a loopback Host and **no web-page `Origin`** (none, or an extension origin such as Passport's background; a site's `fetch` always carries its own), spend each nonce once, refuse devices outside their identity cluster, and wait for a native OS dialog — never the web UI, which any script on that origin could drive. A CLI Hub, a hosted relay, and Android have no such dialog and do not mount the routes.
- **Linking a desktop** uses `POST /services/fabric/link { sessionId }` on the same terms: Passport makes a v2 offer on the desktop's own loopback `/device-links`; the desktop sees only sessions created for its own origin, shows the pairing code in its native dialog, signs as responder, and publishes its half of the `IdentityCrossSign`. Passport countersigns only after the user confirms the same code.
- **Trusted hubs** is the only way to widen where Passport sends data; it never widens which origins may ask to sign in.

**Basics coverage:** [`tests/adversarialEnvironment.basics.unit.ts`](tests/adversarialEnvironment.basics.unit.ts). Related: [`tests/fabricHubAllowlist.unit.ts`](tests/fabricHubAllowlist.unit.ts).

## Outstanding (PR #3 / RSI follow-ups)
- **Page-world 402 fetch patch** — `installFabric402FetchInterceptor` runs in the isolated content script (login/device-link messaging needs that world). Page `fetch` stays unpatched until a page-world injector lands. Hub/UI 402 keeps using extension UI prompts. Module `src/content/fabric402FetchPatch.ts` exists; the limit is world isolation.
- **xpub in query strings** — wallet balance / history still use Hub `GET /services/bitcoin/xpub…` (Hub API shape); moving xpub into POST bodies needs coordinated Hub endpoints.
- ~~**`@fabric/core` / `@fabric/http` pin hygiene**~~ — `package.json` tracks `FabricLabs/fabric#feature/locks` and `FabricLabs/fabric-http#feature/fomantic`. Lockfile SHAs **`984b874ba14771bc491588460c7168e3ebae5410`** / **`b87b1b00b0bc4f9cf5f173d0fd8f6d24339c140e`** (same pair in [docs/OUTSTANDING.md](docs/OUTSTANDING.md)). Bump with Hub / http; re-pin releases to those SHAs. `report:install` removes `package-lock.json` then `npm i --allow-git=all`.
- ~~**Cleartext production hub defaults**~~ — Passport allowlist matches `@fabric/http`: HTTPS-only network hubs; cleartext requires `opts.extra`. Loopback `http://` remains allowed.
- ~~**Device-link Origin/Referer**~~ — device-link fetch/POST omit client-set Origin/Referer; Hub allowlisted thin-client `chrome-extension:` / `moz-extension:` Origins.
- **npm audit (prod omit-dev)** — remaining findings include `uuid` (jayson via core), and `@babel/core` sourceMappingURL advisory on some trees. Prefer upstream bumps / careful overrides over `npm audit fix --force`. Re-check after each Fabric pin bump.
- **Manifest net permissions** — `webRequest` / `declarativeNetRequest` remain declared for identity outband header rules; keep rule IDs and handlers in sync when changing outband behavior.
- **Large work-in-progress split** — keep identity / mesh / payments / packaging as stacked PRs when review tooling hits file limits.

## Already addressed (do not re-open without new evidence)
- ~~Device-link `sessionId` not bound into attest messages~~ — device-link v2 (Hub-chosen `sessionId` + `nonce`, both in the offer and link messages; Passport rebuilds and compares). [AUDIT.md](AUDIT.md) #6.
- ~~Mesh registration for any page~~ — `FABRIC_HUB_REGISTER_MESH` requires the sending tab's origin to equal the allowlisted hub it registers.
- ~~Missing `fabric402FetchPatch` module~~ — present under `src/content/`.
- ~~`deriveReceiveAddress` invalid index~~ — rejects non-integer / negative indexes before derivation.
- ~~Fabric node UI-test harness hard-coded `:3044`~~ — `fabricNodeListRowRe` / `ensureHarnessFabricNodeActive` derive host:port from `baseURL`.
- ~~`zip-dist` version / exec failures~~ — semver gate + `spawnSync` error handling.
- ~~`shell.nix` `ls --color`~~ — probes GNU coreutils vs BSD before aliasing.
- ~~Local test server readiness~~ — 2xx-only probe; spawn waits for `/api/endpoint`; stop awaits real `exit`.
- ~~Trusted-origin merge races~~ — serialized `mergeTrustedNodeOrigin` queue.
- ~~BOLT11 / bitcoin fetch hangs~~ — AbortController timeouts on node RPC and bitcoin HTTP helpers.
- ~~Wallet balance NaN~~ — finite guards on sats parse + `formatBtc` / `formatSats`.
- ~~Activity timestamp domain~~ — finite non-negative only on write/read.

## Process
1. `npm run test:unit` before merging identity / allowlist changes.
2. Never commit mnemonics, `.pem` signing keys for store packages, or unlocked datastores. Chrome Web Store listing copy and graphics: [`docs/CHROME_WEB_STORE.md`](docs/CHROME_WEB_STORE.md).
3. Treat every web origin as potentially malicious when requesting signatures.
4. Prefer `npm ci` / keep `package-lock.json`; `npm run report:install` removes `package-lock.json` then `npm i --allow-git=all`.

## Disclosure
Canonical monitored contact: **`security@fabric.pub`**. GitHub Security Advisories are the alternate private channel.
