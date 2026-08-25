'use strict';

/**
 * Chrome Web Store listing graphics (not packed into the extension zip).
 *
 *   npm run store:assets
 *
 * Listing icons and promo art use the Fabric lettermark (serif f on royal purple).
 * Toolbar icons: `npm run icons:from-avatar` or `@fabric/http` `npm run make:icons`.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'store');
const BG = '#0b0f1a';
const CARD = '#1b1c1d';
const TEAL = '#2dd4bf';
const TEXT = '#f9fafb';
const MUTED = '#d1d5db';

function brandMasterPath () {
  const candidates = [
    path.join(ROOT, '..', 'fabric-http', 'assets', 'icons', 'icon-512.png'),
    path.join(ROOT, 'assets', 'icons', 'icon192.png'),
    path.join(ROOT, 'assets', 'icons', 'icon128.png'),
    path.join(ROOT, 'store', 'icons', 'icon-512.png')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error('Fabric lettermark PNG missing. Run `npm run make:icons` in fabric-http.');
}

function brandPng (size) {
  return sharp(brandMasterPath()).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
}

function escapeXml (s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapLines (text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function writePromoSmall (outPath) {
  const art = 168;
  const png = await brandPng(art);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280">
    <rect width="440" height="280" fill="${BG}"/>
    <text x="220" y="252" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" fill="${TEAL}">Fabric Passport</text>
  </svg>`);
  await sharp(svg)
    .composite([{ input: png, left: Math.round((440 - art) / 2), top: 36 }])
    .png()
    .toFile(outPath);
}

async function writeMarquee (outPath) {
  const art = 360;
  const png = await brandPng(art);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="560">
    <rect width="1400" height="560" fill="${BG}"/>
    <text x="780" y="250" font-family="ui-sans-serif, system-ui, sans-serif" font-size="56" font-weight="700" fill="${TEXT}">Fabric Passport</text>
    <text x="780" y="310" font-family="ui-sans-serif, system-ui, sans-serif" font-size="24" fill="${MUTED}">Sign in to Fabric websites with your own keys</text>
  </svg>`);
  await sharp(svg)
    .composite([{ input: png, left: 120, top: 100 }])
    .png()
    .toFile(outPath);
}

function screenshotSvg (opts) {
  const { kicker, title, body, buttons } = opts;
  const cardX = 420;
  const cardY = 80;
  const inset = 36;
  const textX = cardX + inset;
  const bodyLines = [];
  for (const para of body) {
    bodyLines.push(...wrapLines(para, 38), '');
  }
  const textEls = bodyLines.map((line, i) =>
    `<text x="${textX}" y="${cardY + 88 + i * 22}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="16" fill="${MUTED}">${escapeXml(line)}</text>`
  ).join('');
  const btnX = cardX + inset;
  const btnW = 440 - inset * 2;
  const btnY0 = 500;
  const btnEls = (buttons || []).map((b, i) => {
    const y = btnY0 + i * 56;
    const fill = b.primary ? '#21ba45' : '#2185d0';
    return `<rect x="${btnX}" y="${y}" width="${btnW}" height="44" rx="6" fill="${fill}"/>
      <text x="${btnX + btnW / 2}" y="${y + 28}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="16" fill="#fff">${escapeXml(b.label)}</text>`;
  }).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">
    <rect width="1280" height="800" fill="${BG}"/>
    <text x="640" y="48" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" fill="${TEAL}">${escapeXml(kicker)}</text>
    <rect x="${cardX}" y="${cardY}" width="440" height="640" rx="12" fill="${CARD}"/>
    <text x="640" y="${cardY + 48}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="22" font-weight="700" fill="${TEXT}">${escapeXml(title)}</text>
    ${textEls}
    ${btnEls}
  </svg>`);
}

const SCREENSHOTS = [
  {
    file: '01-welcome-1280x800.png',
    kicker: 'Fabric Passport',
    title: 'Fabric Passport',
    body: ['You don\'t have an identity yet.'],
    buttons: [
      { label: 'Create New »', primary: true },
      { label: 'Use Existing »', primary: false }
    ]
  },
  {
    file: '02-security-1280x800.png',
    kicker: 'Fabric Passport',
    title: 'Important Security Information',
    body: [
      'A seed phrase and password can be used to recover your identity, including its funds.',
      'Your seed phrase and password should never be shared with anyone and must be stored securely (not on this device).'
    ],
    buttons: [
      { label: '« Go Back', primary: false },
      { label: 'Let\'s Go »', primary: true }
    ]
  },
  {
    file: '03-site-login-1280x800.png',
    kicker: 'Fabric Passport',
    title: 'Sign in to website',
    body: [
      'A site is asking Fabric Passport to prove your identity. Approve only if you started this login.',
      'Site  hub.fabric.pub'
    ],
    buttons: [
      { label: 'Ignore', primary: false },
      { label: 'Approve & sign', primary: true }
    ]
  },
  {
    file: '04-device-link-1280x800.png',
    kicker: 'Fabric Passport',
    title: 'Link this device',
    body: [
      'Any Fabric peer (Passport, Android, or desktop) can create or accept this link. Separate seeds, dual BIP340 Schnorr.',
      'Approve only if you started this on the other device.'
    ],
    buttons: [
      { label: 'Ignore', primary: false },
      { label: 'Approve & link', primary: true }
    ]
  },
  {
    file: '05-hub-connect-1280x800.png',
    kicker: 'Fabric Passport',
    title: 'Fabric node',
    body: [
      'Connected.',
      'Connect & register talks to the Hub you chose, verifies its identity, and registers this wallet for notifications. Keys stay on this computer.'
    ],
    buttons: [
      { label: 'Connect & register', primary: true }
    ]
  }
];

async function main () {
  const dirs = [
    path.join(STORE, 'icons'),
    path.join(STORE, 'promo'),
    path.join(STORE, 'screenshots')
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });

  const icon128 = path.join(STORE, 'icons', 'icon-128.png');
  const icon512 = path.join(STORE, 'icons', 'icon-512.png');
  const master = await sharp(brandMasterPath()).png().toBuffer();
  await sharp(master).resize(128, 128).png().toFile(icon128);
  await sharp(master).resize(512, 512).png().toFile(icon512);
  console.log('Wrote', path.relative(ROOT, icon128), path.relative(ROOT, icon512));

  const small = path.join(STORE, 'promo', 'small-440x280.png');
  const marquee = path.join(STORE, 'promo', 'marquee-1400x560.png');
  await writePromoSmall(small);
  await writeMarquee(marquee);
  console.log('Wrote', path.relative(ROOT, small), path.relative(ROOT, marquee));

  for (const shot of SCREENSHOTS) {
    const out = path.join(STORE, 'screenshots', shot.file);
    await sharp(screenshotSvg(shot)).png().toFile(out);
    console.log('Wrote', path.relative(ROOT, out));
  }

  console.log('Done. Fabric lettermark.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
