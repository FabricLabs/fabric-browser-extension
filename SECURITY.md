# Security (Fabric Passport / browser extension)
Browser wallet and identity extension for Fabric site login and mesh participation.

## Adversarial environment
Fabric networks are intended for deployment where **peers, relays, hubs, and operators may be hostile**. Design and review against:

- Untrusted TCP / WebSocket / WebRTC neighbors (forgery, replay, amplification, pin hijack)
- Phishing of identity flows (`fabric://login`, device-link) toward attacker-controlled hubs
- Public observability of unsigned or plaintext application traffic unless an explicit seal is used
- No reliance on an “honest majority” of random internet peers for key custody

The extension MUST refuse to sign site-login / device-link completions for non-allowlisted Hub origins. Seed material stays in encrypted extension storage; content scripts are untrusted relative to the background.

**Basics coverage:** [`tests/adversarialEnvironment.basics.unit.ts`](tests/adversarialEnvironment.basics.unit.ts). Related: [`tests/fabricHubAllowlist.unit.ts`](tests/fabricHubAllowlist.unit.ts).

## Outstanding (PR #3 / RSI follow-ups)
- **Page-world 402 fetch patch** — `installFabric402FetchInterceptor` runs in the isolated content script today (login/device-link messaging needs that world). Page `fetch` is not patched until a MAIN-world injector (or dual `content_scripts` entry) lands; keep Hub/UI 402 flows working via extension UI prompts in the meantime. Module `src/content/fabric402FetchPatch.ts` exists; limitation is world isolation, not a missing file.
- **xpub in query strings** — wallet balance / history still use Hub `GET /services/bitcoin/xpub…` (Hub API shape); moving xpub into POST bodies needs coordinated Hub endpoints.
- ~~**`@fabric/core` / `@fabric/http` pin hygiene**~~ — pins: core `aa516d31…`, http `54560cb9…` (aligned with Hub RSI after `npm run report:install` from `feature/rsi`). Bump deliberately with Hub / http; do not leave moving branch tips in releases. `report:install` keeps `package-lock.json`.
- ~~**Cleartext production hub defaults**~~ — Passport allowlist matches `@fabric/http`: HTTPS-only network hubs; cleartext requires `opts.extra`. Loopback `http://` remains allowed.
- **npm audit (prod omit-dev)** — remaining findings include transitive `elliptic` (crypto-browserify via `@fabric/http`), `uuid` (jayson via core), and `@babel/core` sourceMappingURL advisory on some trees. Prefer upstream bumps / careful overrides over `npm audit fix --force`. Re-check after each Fabric pin bump.
- **Manifest net permissions** — `webRequest` / `declarativeNetRequest` remain declared for identity outband header rules; keep rule IDs and handlers in sync when changing outband behavior.
- **Large WIP split** — keep identity / mesh / payments / packaging as stacked PRs when review tooling hits file limits.

## Already addressed (do not re-open without new evidence)
- ~~Missing `fabric402FetchPatch` module~~ — present under `src/content/`.
- ~~`deriveReceiveAddress` invalid index~~ — rejects non-integer / negative indexes before derivation.
- ~~Fabric node UI-test harness hard-coded `:3044`~~ — `fabricNodeListRowRe` / `ensureHarnessFabricNodeActive` derive host:port from `baseURL`.
- ~~`zip-dist` version / exec failures~~ — semver gate + `spawnSync` error handling.
- ~~`shell.nix` GNU `ls --color`~~ — probes GNU vs BSD before aliasing.
- ~~Local test server readiness~~ — 2xx-only probe; spawn waits for `/api/endpoint`; stop awaits real `exit`.
- ~~Trusted-origin merge races~~ — serialized `mergeTrustedNodeOrigin` queue.
- ~~BOLT11 / bitcoin fetch hangs~~ — AbortController timeouts on node RPC and bitcoin HTTP helpers.
- ~~Wallet balance NaN~~ — finite guards on sats parse + `formatBtc` / `formatSats`.
- ~~Activity timestamp domain~~ — finite non-negative only on write/read.

## Process
1. `npm run test:unit` before merging identity / allowlist changes.
2. Never commit mnemonics, `.pem` signing keys for store packages, or unlocked datastores.
3. Treat every web origin as potentially malicious when requesting signatures.
4. Prefer `npm ci` / keep `package-lock.json`; `npm run report:install` removes `node_modules` only.

## Disclosure
Report issues via the repository issue tracker / maintainer contact in README.
