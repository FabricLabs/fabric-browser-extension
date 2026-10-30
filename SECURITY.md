# Security (Fabric Passport / browser extension)
Browser wallet and identity extension for Fabric site login and mesh participation.

**Outstanding queue:** [docs/OUTSTANDING.md](docs/OUTSTANDING.md).
**Posture, known gaps, and release recommendations:** [AUDIT.md](AUDIT.md).

## Adversarial environment
Fabric networks are intended for deployment where **peers, relays, hubs, and operators may be hostile**. Design and review against:

- Untrusted TCP (Transmission Control Protocol) / WebSocket / WebRTC neighbors (forgery, replay, amplification, pin hijack)
- Phishing of identity flows (sign-in, linking a signer, delegated requests) toward attacker-controlled sites and hubs
- Public observability of unsigned or plaintext application traffic unless an explicit seal is used
- No reliance on an “honest majority” of random internet peers for key custody

Passport sends pairing frames, delegation requests, and results only to trusted Hubs (allowlist plus the user's sealed Trusted hubs list) and to loopback apps. Passport keeps only the master xprv, sealed under the lock password (at least 12 characters; PBKDF2 600,000 iterations, older seals re-sealed on unlock); while unlocked it sits in `chrome.storage.session` (trusted contexts only) and is cleared on lock, by the popup's timer or by a background `chrome.alarms` alarm when the popup is closed. On unlock the cached public keys are checked against the master. Content scripts are untrusted relative to the background: what they can write in `chrome.storage.local` (Trusted hubs, trusted HTTP origins, linked signers and their grants, signed-in sites) carries an HMAC keyed from the master, and an entry whose MAC fails is dropped.

## Passport v2 sign-in
Pages and Passport exchange canonical `fabric:<frame>` strings (whole signed AMP frames, checked with `@fabric/core` `decodeFabricUri`). Types: `PASSPORT_CHALLENGE` 0x4240, `PASSPORT_ASSERTION` 0x4241. Pages find Passport with a `PASSPORT_HELLO` handshake on a transferred port; Passport marks nothing on the page. Spec: `@fabric/core` `docs/PASSPORT.md`.

- **Origin comes from the browser.** The content script forwards `PASSPORT_CHALLENGE` posts with the page's `MessagePort`; the background binds the challenge to `sender.origin` / `sender.url`, never to a field the page wrote, and refuses one naming another origin. Only HTTPS and loopback origins may ask, only the top page or a same-origin frame, one challenge per tab and frame, each nonce once. The answer goes back to that frame's port only.
- **Nothing extra without consent.** A site Passport has not signed in to sees its own pairwise identity key by default, so sites can't link the user across origins; the main identity is a choice in the prompt. The prompt shows the registrable domain in bold, flags look-alikes of sites already used and international characters, and badges new sites. Wallet xpubs and the cosigner key go only when the site asked and the user ticked them.
- **The user picks the account and network** in the popup: Passport signs directly, or asks a linked signer that was granted sign-ins. Its answer must be signed by the key the link pinned and name this Passport.

## Linked signers (delegation)
Passport, Hub, and GoonCitizen link as peers that each keep their own key and message store. Every step is a Fabric message (`DELEGATION_*` 0x4243–0x424A; spec `@fabric/core` `docs/DELEGATION.md`).

- **Linking needs the user on both sides.** Offer, answer, and reveal commit each side's nonce before the six-digit code exists, so a relay in the middle can't pick a matching code. Nothing is granted until the user confirms the codes match (the button arms after a short delay).
- **Grants are narrow and revocable.** A `DELEGATION_GRANT` names scopes (identity, sign-ins, shared wallets, other messages); `DELEGATION_REVOKE` withdraws one. Every request is checked against a live grant from that requester.
- **Every request asks the user.** A `DELEGATION_REQUEST` becomes a notification and a badge count; the popup opens only from a click. The user sees what will be signed (the site, the shared wallet, or the message type) and signs or declines; expired requests are declined.
- **Transport is untrusted.** Loopback apps are reached at `/services/delegation/*`; others through a trusted Hub's `/delegations` rendezvous and `/services/delegation/mailbox`. Frames are signed end to end; a Hub only carries them.
- **Trusted hubs** is the only way to widen where Passport sends data; it never widens which origins may ask to sign in.

**Basics coverage:** [`tests/adversarialEnvironment.basics.unit.ts`](tests/adversarialEnvironment.basics.unit.ts). Related: [`tests/fabricHubAllowlist.unit.ts`](tests/fabricHubAllowlist.unit.ts).

## Outstanding (PR #3 / RSI follow-ups)
- **Page-world 402 fetch patch** — `installFabric402FetchInterceptor` runs in the isolated content script (sign-in messaging needs that world). Page `fetch` stays unpatched until a page-world injector lands. A 402 it sees is only reported; Passport's own popup shows and pays it (no in-page overlay, and pages can't ask Passport to pay).
- **xpub in query strings** — wallet balance / history still use Hub `GET /services/bitcoin/xpub…` (Hub API shape); moving xpub into POST bodies needs coordinated Hub endpoints.
- ~~**`@fabric/core` / `@fabric/http` pin hygiene**~~ — `package.json` tracks `FabricLabs/fabric#feature/locks` and `FabricLabs/fabric-http#feature/fomantic`. Lockfile SHAs **`984b874ba14771bc491588460c7168e3ebae5410`** / **`b87b1b00b0bc4f9cf5f173d0fd8f6d24339c140e`** (same pair in [docs/OUTSTANDING.md](docs/OUTSTANDING.md)). Bump with Hub / http; re-pin releases to those SHAs. `report:install` removes `package-lock.json` then `npm i --allow-git=all`.
- ~~**Cleartext production hub defaults**~~ — Passport allowlist matches `@fabric/http`: HTTPS-only network hubs; cleartext requires `opts.extra`. Loopback `http://` remains allowed.
- **npm audit (prod omit-dev)** — remaining findings include `uuid` (jayson via core), and `@babel/core` sourceMappingURL advisory on some trees. Prefer upstream bumps / careful overrides over `npm audit fix --force`. Re-check after each Fabric pin bump.
- **Manifest net permissions** — `webRequest` / `declarativeNetRequest` remain declared for identity outband header rules (limited to each trusted origin's own requests with `initiatorDomains`); keep rule IDs and handlers in sync when changing outband behavior.
- **Large work-in-progress split** — keep identity / mesh / payments / packaging as stacked PRs when review tooling hits file limits.

## Already addressed (do not re-open without new evidence)
- ~~Device-link `sessionId` not bound into attest messages~~ — superseded: device links are gone; linking is the delegation protocol's commit-then-reveal exchange. [AUDIT.md](AUDIT.md) #6.
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
