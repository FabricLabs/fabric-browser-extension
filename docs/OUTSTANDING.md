# Outstanding (security-first)
Living queue for this repo. Detail and closed items live in [SECURITY.md](../SECURITY.md). Suite march: [@fabric/core `docs/PRODUCTION_MARCH.md`](https://github.com/FabricLabs/fabric/blob/feature/rsi/docs/PRODUCTION_MARCH.md).

**Last reviewed:** 2026-08-13 (`feature/rsi`; pins `#feature/rsi` → core `3745041e`, http `e167d8e`).

## Blockers before store / shared-host pairing claims
1. **Page-world 402 fetch patch** — `installFabric402FetchInterceptor` is isolated-world today; page `fetch` is not patched until a MAIN-world injector lands. Hub/UI 402 stays on extension UI prompts.
2. **Hub login/link redeem** — Passport signs client-side; Hub/`@fabric/http` still treat QR `sessionId` as the poll capability. Do not treat Origin headers as possession proof.
3. **Never commit** `assets.pem`, store zips, or unlocked datastores.

## Next slices
- [ ] Move xpub off Hub `GET /services/bitcoin/xpub…` query strings (needs Hub POST endpoints).
- [ ] Keep `src/utils/identityCrossSign.ts` lockstep with `@fabric/hub/functions/identityCrossSign` (TS copy is required; webpack must not pull Hub Node).
- [ ] Keep `src/utils/fabricHubAllowlist.ts` lockstep with `@fabric/http/functions/fabricHubAllowlist`.
- [ ] Bind device-link `sessionId` into attest messages when http/Hub land that protocol bump.
- [ ] Open a `feature/rsi` PR against FabricLabs when this cut is pushed — **[PR #3](https://github.com/FabricLabs/fabric-browser-extension/pull/3) is `eric/develop`**, not this work.

## Closed / in this cut
- Device-link initiator + responder; IdentityCrossSign publish/revoke; linked-device roster.
- chrome-extension / moz-extension Origins accepted by Hub http thin-client gate on allowlisted hubs.
- HTTPS-only default hub allowlist; phishing origins refused in `tests/adversarialEnvironment.basics.unit.ts`.

## PRs
No human review comments on PR #3. Do not merge or retarget that branch as the RSI deploy.
