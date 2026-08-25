# Chrome Web Store — Fabric Passport

Copy-paste pack for [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
Do not upload `*.pem`, `*.crx`, or `zip/*.zip` to git. Chrome signs the item; local packing keys stay off-repo.

**Package:** `npm run package` → `zip/fabric-passport-v0.1.0.zip` (from `dist/`, test harness pages stripped).  
**Listing graphics:** `npm run store:assets` writes `store/`.  
**Privacy URL (after Hub deploy):** `https://hub.fabric.pub/passport-privacy.html`  
Canonical policy: [`docs/privacy-policy.md`](privacy-policy.md) · hosted HTML: [`store/privacy.html`](../store/privacy.html) (copy onto Hub as `assets/passport-privacy.html`).

Until that Hub path is live, host `store/privacy.html` on any HTTPS origin you control and paste that URL. GitHub blob pages are a weak choice; reviewers want a stable, dedicated policy page.

---

## Before you click Publish

1. Chrome Web Store **developer account** ($5 once). Publisher name **Fabric Labs**.
2. Verify **hub.fabric.pub** in Search Console if you want the official-URL badge.
3. Deploy `store/privacy.html` → `https://hub.fabric.pub/passport-privacy.html`.
4. `npm run store:assets` (icons + promo + screenshots).
5. `npm run package` and upload the zip from `zip/`.
6. Prefer **Trusted testers** for the first review, then public.

Outstanding product caveats (do not claim otherwise in the listing): page-world 402 fetch is still isolated-world; Hub login redeem is still `sessionId` capability — see [`docs/OUTSTANDING.md`](OUTSTANDING.md).

---

## Product / listing tab

### Name
```
Fabric Passport
```
Must match `src/manifest.json` `"name"`. Not `@fabric/passport` (npm name stays that).

### Summary (manifest description, ≤132 characters — already in the zip)
```
Sign in to Fabric websites with your own cryptographic identity. Create, restore, and link devices — keys stay on this computer.
```

### Detailed description
```
Fabric Passport is a Chromium identity wallet for the Fabric network. Create or restore a cryptographic identity on this computer, then use it to sign in to Fabric websites and to link other devices (Passport, GoonCitizen desktop, or Android) as one cluster.

Keys never leave the extension unless you export a backup. Site login and device-link prompts only sign after you approve. Public hubs must be HTTPS; loopback http:// is for a Hub you run locally.

What you can do
• Create a new identity (seed + password) or restore from an existing seed
• Sign in to Fabric sites that use Hub client-signed sessions (Sign in with Passport)
• Create or accept a device-link offer (fabric://link) and publish IdentityCrossSign
• Connect & register with a Fabric Hub you choose (default https://hub.fabric.pub)
• Optional Bitcoin addresses and Hub wallet actions derived from the same identity

What this is not
• Not a general password manager, ad blocker, or page scraper
• Not a custodial account at Fabric Labs — we never receive your seed
• Not required to talk to relay.goon.vc; that host is only one possible pairing hub

Language: English. Category: Productivity. Content rating: not mature.
```

### Category
**Productivity**

### Language
**English (United States)**

### Graphic assets (upload from `store/`)

| Dashboard field | File | Size |
| --- | --- | --- |
| Store icon | `store/icons/icon-128.png` | 128×128 PNG (Fabric lettermark, full-bleed) |
| Extra icon (if asked) | `store/icons/icon-512.png` | 512×512 PNG |
| Screenshot 1 | `store/screenshots/01-welcome-1280x800.png` | 1280×800 |
| Screenshot 2 | `store/screenshots/02-security-1280x800.png` | 1280×800 |
| Screenshot 3 | `store/screenshots/03-site-login-1280x800.png` | 1280×800 |
| Screenshot 4 | `store/screenshots/04-device-link-1280x800.png` | 1280×800 |
| Screenshot 5 | `store/screenshots/05-hub-connect-1280x800.png` | 1280×800 |
| Small promo tile (required) | `store/promo/small-440x280.png` | 440×280 |
| Marquee (optional) | `store/promo/marquee-1400x560.png` | 1400×560 |
| Promo video | omit until you have a YouTube walkthrough | — |

Screenshots are listing boards that reproduce the real popup copy (onboarding, security warning, site login, device link, Connect & register). Replace with live captures from a load-unpacked build if you prefer; keep 1280×800, square corners, no padding.

### Homepage URL
```
https://hub.fabric.pub
```

### Support URL
```
https://github.com/FabricLabs/fabric-browser-extension/issues
```

### Official URL
`https://hub.fabric.pub` after Search Console verification.

### Mature content
**No**

### Visibility
First pass: **Trusted testers**. Then **Public**.

### Distribution
All regions.

---

## Privacy practices tab

### Single purpose
```
Let the user hold a Fabric cryptographic identity in Chromium and use it to sign in to Fabric websites and link their other Fabric devices. Bitcoin addresses shown in the wallet are derived from that same identity; they are not a second product.
```

### Remote code
Select **No, I am not using remote code.**

If a reviewer asks about `wasm-unsafe-eval` in the extension CSP:
```
No remote scripts. The CSP token wasm-unsafe-eval is required to instantiate the bundled tiny-secp256k1 WebAssembly already inside the package. We do not fetch or eval code from the network.
```

### Data types (checkboxes)

Check **Yes** / collected for:

- **Personally identifiable information** — Fabric public key / identity id; labels the user types. Use: **core extension functionality**.
- **Financial and payment information** — Bitcoin addresses / xpub; optional Lightning pay through the user’s Hub. Use: **core extension functionality**.
- **Authentication information** — encrypted seed, password verifier, session/device-link approval state. Use: **core extension functionality**.
- **Web history** — only Hub origins the user Connects to, and the origin of a Fabric login/link prompt they see. Not a log of all browsing. Use: **core extension functionality**.
- **User activity** — last-activity timestamp; coarse byte/request counts on those trusted Hub origins (in-memory / local). Use: **core extension functionality**.

Leave **unchecked** (not collected): Health, Personal communications, Location, Website content.

If the dashboard forces a “how used” pick for each checked type, choose **core functionality** only. Do not check analytics, advertising, or personalization.

### Limited Use certifications

Check **all** of:

- I do not sell or transfer user data to third parties outside of the approved use cases
- I do not use or transfer user data for purposes unrelated to my item’s single purpose
- I do not use or transfer user data to determine credit-worthiness or for lending purposes

### Privacy policy URL
```
https://hub.fabric.pub/passport-privacy.html
```

---

## Permission justifications

Paste into each dashboard field. Remove a permission from the manifest instead of inventing a use.

### `storage`
```
Stores the encrypted identity, settings, trusted Hub origins, and pending site-login / device-link challenges on this profile. Wallet material is encrypted at rest (AES-GCM). Nothing is synced to Fabric Labs.
```

### `tabs`
```
After the user approves or ignores a site-login or device-link prompt, Passport messages the originating tab (chrome.tabs.sendMessage) so the page can continue. We do not read browsing history or inject into arbitrary tabs from the toolbar.
```

### `notifications`
```
Shows an optional Chromium notification when the connected Fabric Hub delivers a user-facing message (for example a mesh registration or payment result). The user can disable Chrome notifications at the OS / browser level.
```

### `offscreen`
```
Keeps a Hub WebRTC signaling helper alive in an offscreen document (chrome.offscreen reason WEB_RTC) after the Hub tab is closed, so Connect & register mesh stays up. No hidden crawling.
```

### `alarms`
```
A 5-minute keepalive alarm re-syncs Hub mesh registration from storage if the service worker was asleep. Not used for tracking.
```

### `webRequest`
```
Observes request counts and Content-Length totals only for origins the user added via Connect & register. Other sites are ignored. This is not a general traffic interceptor and does not block or rewrite unrelated requests.
```

### `declarativeNetRequest`
```
After Connect & register, adds the public X-Fabric-Identity header (id1… bech32, no private key) on requests to those trusted Hub origins so the Hub can recognize this wallet. Rules are removed when the origin is no longer trusted.
```

### Host permission `https://*/*`
```
Fabric sites and Hubs are not a single domain. The content script only handles Fabric postMessage (site login, device link, Hub mesh-bridge). Host access is also required so declarativeNetRequest can attach X-Fabric-Identity on whatever Hub origin the user trusted. We do not scrape pages or collect a general browsing history.
```

### Every `http://localhost…` and `http://127.0.0.1…` host permission
Paste the **same** text for each loopback pattern (Chrome lists them separately; match patterns cannot wildcard ports):
```
Loopback-only access so a developer or operator can use a Fabric Hub, GoonCitizen LiveRelay, or the Passport test harness on this machine (cleartext HTTP is refused for public hubs). The content script still only acts on Fabric postMessage. Not used to reach the public internet over HTTP.
```

---

## Account tab (developer)

| Field | Value |
| --- | --- |
| Display name | Fabric Labs |
| Email | security@fabric.pub |
| Website | https://hub.fabric.pub |
| Privacy policy (account-level, if asked) | https://hub.fabric.pub/passport-privacy.html |

---

## Reviewer notes (optional “comments to reviewer”)
```
Fabric Passport is a local identity wallet for Fabric (hub.fabric.pub). Single purpose: hold a user-controlled key and sign Fabric site-login / device-link challenges after an in-extension approval.

Broad https://*/* is so any Fabric site can postMessage a login request; the content script ignores everything else. webRequest + declarativeNetRequest apply only after the user Connects to a Hub.

No remote code. Bundled WASM is secp256k1. Privacy policy: https://hub.fabric.pub/passport-privacy.html

Test Hub: https://hub.fabric.pub — click Connect & register in the popup after creating an identity, or use the onboarding Create New flow. Loopback http://127.0.0.1:8080 is a local Hub.
```
