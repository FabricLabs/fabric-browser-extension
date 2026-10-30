# Privacy Policy — Fabric Passport

**Product:** Fabric Passport (`@fabric/passport`), a Chromium extension  
**Operator:** Fabric Labs  
**Effective:** 26 October 2026  
**Contact:** [security@fabric.pub](mailto:security@fabric.pub)

This policy describes how Fabric Passport handles information on your computer and what, if anything, leaves the extension. It is written to satisfy the Chrome Web Store User Data Policy, including Limited Use.

**The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.**

## 1. What this extension is

Fabric Passport is a **local cryptographic identity wallet**. It lets you create or restore a Fabric identity, sign in to Fabric websites (Passport v2: you approve each sign-in for the site your browser shows), link other signers (another Passport, Fabric Hub, or GoonCitizen) that each keep their own key and may ask you to sign, and use Bitcoin keys from the same seed against a Fabric Hub **you** choose. Each account has a separate identity key, wallet keys, and escrow (cosigner) key, so signing in doesn't reveal your wallet.

Fabric Labs does **not** operate a cloud account for Passport. There is no Passport signup with us. We do not receive your seed phrase, wallet password, or private keys.

## 2. Information handled on this device

The following is stored in Chromium extension storage on **your** machine (encrypted at rest with AES-GCM where the implementation encrypts wallet material):

| Category | What | Leaves this device? |
| --- | --- | --- |
| Authentication information | Your master extended private key, sealed with AES-GCM under your lock password (the seed phrase and BIP39 passphrase are not kept after import) | **No** (unless you export an encrypted backup yourself) |
| Personally identifiable information | Fabric identity public key / id (`id1…`) of each account; optional display labels you type | An identity public key is sent only to Hubs **you** connect to or sites **you** approve a sign-in for |
| Financial and payment information | Bitcoin addresses and wallet xpubs derived from your seed; optional Lightning invoice you choose to pay | Sent to the active Fabric Hub **you** configured when you use Wallet features. A website gets a wallet xpub or your escrow key only if it asks and you tick that item on the sign-in prompt |
| User activity | Last-activity timestamp; coarse request counts and `Content-Length` sums for **trusted Hub origins** only | **No** — kept in memory / local storage for the extension UI |
| Web history (narrow) | Origins of Fabric Hubs you **Connect & register**; the origin of a sign-in you are asked to approve; the signers you linked and what each may ask for; payment requests sites made | Shown to you in the approval UI; kept locally |

Passport does **not** collect health information, location, general browsing history, page HTML, cookies from unrelated sites, or advertising identifiers.

The content script runs on HTTPS pages and on loopback addresses (`localhost`, `127.0.0.1`, `[::1]`, any port) so a Fabric site can hand it a sign-in challenge, and so it can report a Lightning invoice a page's request answered with HTTP 402. It does **not** scrape the page. It ignores messages that are not Passport sign-in, payment, or Hub mesh-bridge messages.

## 3. Information sent to other computers

Passport talks to the network only when you use a feature that needs it:

1. **Fabric Hub you choose** (default public hub [https://hub.fabric.pub](https://hub.fabric.pub), or a local/self-hosted Hub, or another allowlisted HTTPS hub). Examples: `GetNetworkStatus`, `RegisterWebRTCPeer`, signed messages to and from your linked signers (the Hub only carries them), optional Bitcoin status / send / Lightning pay through that Hub’s HTTP API.
2. **The website that asked you to sign in**, only after you click **Sign in**. Passport hands the signed answer back to the page; the page sends it to its own server. It holds a BIP340 signature, the identity public key of the account you picked, and only the extras you ticked — never your seed or private keys.
3. **A signer you linked** (another Passport, or Fabric Hub or GoonCitizen on this computer over `127.0.0.1` or through a trusted Hub): the signed messages that link you, what you allow it to ask for, and your answers to its requests. Linking shows the same six-digit code in both places, and nothing is signed for it until you approve each request.
4. **Chrome / Google** as part of installing or updating the extension from the Chrome Web Store. Fabric Labs does not receive that telemetry.

Public hubs must be HTTPS. Cleartext `http://` is allowed for **loopback** (`localhost` / `127.0.0.1` / `[::1]`) so you can develop against a local Hub, and for a Hub on your **local network** that you add by exact origin under **Trusted hubs** — Passport then asks Chrome for access to that one host (optional `http://*/*` host permission, granted per host) and talks to it only after you accept. Traffic to such a Hub is not encrypted in transit; add only Hubs on networks you trust.

We do **not** sell user data. We do **not** use user data for advertising, credit-worthiness, or lending. We do **not** transfer user data to data brokers.

Hubs you connect to are **independent operators**. Their own privacy practices apply to what they log (IP address, request metadata, published documents). Read that Hub’s policy. Fabric Labs operates hub.fabric.pub; other hosts (including `relay.goon.vc`) are not this extension’s publisher.

## 4. Why we request permissions

Permissions exist so Passport can keep keys on-device, show an approval prompt, inject a small content script for Fabric `postMessage`, keep a WebRTC offscreen document alive for Hub mesh, and (only after **Connect & register**) attach a public `X-Fabric-Identity` header on requests to **that** Hub. See [docs/CHROME_WEB_STORE.md](CHROME_WEB_STORE.md) for the reviewer justifications.

## 5. Retention and deletion

Local data remains until you remove the identity in Passport settings, clear extension storage, or uninstall the extension. Uninstalling Passport deletes Chromium extension storage for this item on that profile.

We cannot remotely delete keys we never received. If you published identity material to a Hub, ask that Hub’s operator about their retention.

## 6. Children

Passport is not directed at children under 13 (or the applicable age in your country). Do not use it to store a child’s identity.

## 7. Changes

We will update this document in the `@fabric/passport` repository when handling changes. The hosted copy at [https://hub.fabric.pub/passport-privacy.html](https://hub.fabric.pub/passport-privacy.html) should stay in lockstep after Hub deploy.

## 8. Contact

Security and privacy: **security@fabric.pub**  
Source and issues: [https://github.com/FabricLabs/fabric-browser-extension](https://github.com/FabricLabs/fabric-browser-extension)
