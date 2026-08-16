# Security (Fabric Passport / browser extension)
Browser wallet and identity extension for Fabric site login and mesh participation.

**Outstanding queue:** [docs/OUTSTANDING.md](docs/OUTSTANDING.md).

## Adversarial environment
Fabric networks are intended for deployment where **peers, relays, hubs, and operators may be hostile**. Design and review against:

- Untrusted TCP (Transmission Control Protocol) / WebSocket / WebRTC neighbors (forgery, replay, amplification, pin hijack)
- Phishing of identity flows (`fabric://login`, device-link) toward attacker-controlled hubs
- Public observability of unsigned or plaintext application traffic unless an explicit seal is used
- No reliance on an “honest majority” of random internet peers for key custody

The extension refuses to sign site-login / device-link completions for non-allowlisted Hub origins. Seed material stays in encrypted extension storage; content scripts are untrusted relative to the background.

**Basics coverage:** [`tests/adversarialEnvironment.basics.unit.ts`](tests/adversarialEnvironment.basics.unit.ts). Related: [`tests/fabricHubAllowlist.unit.ts`](tests/fabricHubAllowlist.unit.ts).

## Outstanding (PR #3 / RSI follow-ups)
- **Page-world 402 fetch patch** — `installFabric402FetchInterceptor` runs in the isolated content script (login/device-link messaging needs that world). Page `fetch` stays unpatched until a page-world injector lands. Hub/UI 402 keeps using extension UI prompts. Module `src/content/fabric402FetchPatch.ts` exists; the limit is world isolation.
- **xpub in query strings** — wallet balance / history still use Hub `GET /services/bitcoin/xpub…` (Hub API shape); moving xpub into POST bodies needs coordinated Hub endpoints.
- ~~**`@fabric/core` / `@fabric/http` pin hygiene**~~ — `package.json` stays on `FabricLabs/fabric#feature/rsi` and `FabricLabs/fabric-http#feature/rsi`. Lockfile SHAs **`f1b5e147d6d48a7689701527a55d1829227529b5`** / **`1b162e355f0c923191f709ac897f1301d995f556`**. Bump with Hub / http; re-pin releases to those SHAs. `report:install` wipes the lockfile then `npm i --allow-git=all`.
- ~~**Cleartext production hub defaults**~~ — Passport allowlist matches `@fabric/http`: HTTPS-only network hubs; cleartext requires `opts.extra`. Loopback `http://` remains allowed.
- ~~**Device-link Origin/Referer**~~ — device-link fetch/POST omit client-set Origin/Referer; Hub allowlisted thin-client `chrome-extension:` / `moz-extension:` Origins.
- **npm audit (prod omit-dev)** — remaining findings include transitive `elliptic` (crypto-browserify via `@fabric/http`), `uuid` (jayson via core), and `@babel/core` sourceMappingURL advisory on some trees. Prefer upstream bumps / careful overrides over `npm audit fix --force`. Re-check after each Fabric pin bump.
- **Manifest net permissions** — `webRequest` / `declarativeNetRequest` remain declared for identity outband header rules; keep rule IDs and handlers in sync when changing outband behavior.
- **Large work-in-progress split** — keep identity / mesh / payments / packaging as stacked PRs when review tooling hits file limits.

## Already addressed (do not re-open without new evidence)
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
4. Prefer `npm ci` / keep `package-lock.json`; `npm run report:install` wipes the lockfile then `npm i --allow-git=all`.

## Disclosure
Canonical monitored contact: **`security@fabric.pub`**. GitHub Security Advisories are the alternate private channel.
