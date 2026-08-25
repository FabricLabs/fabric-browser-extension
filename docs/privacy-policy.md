# Privacy Policy — Fabric Passport

**Product:** Fabric Passport (`@fabric/passport`), a Chromium extension  
**Operator:** Fabric Labs  
**Effective:** 15 August 2026  
**Contact:** [security@fabric.pub](mailto:security@fabric.pub)

This policy describes how Fabric Passport handles information on your computer and what, if anything, leaves the extension. It is written to satisfy the Chrome Web Store User Data Policy, including Limited Use.

**The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.**

## 1. What this extension is

Fabric Passport is a **local cryptographic identity wallet**. It lets you create or restore a Fabric identity, sign in to Fabric websites (client-signed Hub sessions), mutually link devices, and use Bitcoin keys derived from that identity against a Fabric Hub **you** choose.

Fabric Labs does **not** operate a cloud account for Passport. There is no Passport signup with us. We do not receive your seed phrase, wallet password, or private keys.

## 2. Information handled on this device

The following is stored in Chromium extension storage on **your** machine (encrypted at rest with AES-GCM where the implementation encrypts wallet material):

| Category | What | Leaves this device? |
| --- | --- | --- |
| Authentication information | Wallet password verifier; encrypted seed / extended keys | **No** (unless you export a backup yourself) |
| Personally identifiable information | Fabric public key / identity id (`id1…`); optional display labels you type | Public key is sent only to Hubs **you** connect to or sites **you** approve |
| Financial and payment information | Bitcoin addresses and xpub derived from your seed; optional Lightning invoice you choose to pay | Sent only to the active Fabric Hub **you** configured, when you use Wallet features |
| User activity | Last-activity timestamp; coarse request counts and `Content-Length` sums for **trusted Hub origins** only | **No** — kept in memory / local storage for the extension UI |
| Web history (narrow) | Origins of Fabric Hubs you **Connect & register**; origin + session id of a site-login or device-link you are asked to approve | Shown to you in the approval UI; Hub origin list stays local unless you use that Hub |

Passport does **not** collect health information, location, general browsing history, page HTML, cookies from unrelated sites, or advertising identifiers.

The content script runs on HTTPS pages (and listed loopback Hub ports) so a Fabric site can `postMessage` a login or device-link request. It does **not** scrape the page. It ignores messages that are not Fabric site-login, device-link, or Hub mesh-bridge messages.

## 3. Information sent to other computers

Passport talks to the network only when you use a feature that needs it:

1. **Fabric Hub you choose** (default public hub [https://hub.fabric.pub](https://hub.fabric.pub), or a local/self-hosted Hub, or another allowlisted HTTPS hub). Examples: `GetNetworkStatus`, `RegisterWebRTCPeer`, client-signed `POST /sessions/:id/signatures`, device-link signatures, optional Bitcoin status / send / Lightning pay through that Hub’s HTTP API.
2. **The website that asked you to sign in**, only after you click **Approve & sign** (or **Approve & link**). The payload is a BIP340 signature plus public identity material — not your seed.
3. **Chrome / Google** as part of installing or updating the extension from the Chrome Web Store. Fabric Labs does not receive that telemetry.

Cleartext `http://` is allowed only for **loopback** (`localhost` / `127.0.0.1`) so you can develop against a local Hub. Public hubs must be HTTPS.

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
