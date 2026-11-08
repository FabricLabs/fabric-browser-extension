'use strict';

/**
 * Runtime messages between Passport's pages and the background for linked
 * signers (delegation). All of them answer extension pages only.
 */

/** Linked signers, grants, pending requests, and the open pairing. */
export const DELEGATION_STATE = 'FABRIC_DELEGATION_STATE';
/** Apps answering on this computer (`GET /services/delegation`). */
export const DELEGATION_DISCOVER = 'FABRIC_DELEGATION_DISCOVER';
/** Pair with an app on this computer: `{ base }`. */
export const DELEGATION_PAIR_LOCAL = 'FABRIC_DELEGATION_PAIR_LOCAL';
/** Pair through a Hub's rendezvous, showing an invitation: `{ hub }`. */
export const DELEGATION_PAIR_HUB = 'FABRIC_DELEGATION_PAIR_HUB';
/** Pair from an invitation another participant showed: `{ invitation }`. */
export const DELEGATION_PAIR_INVITATION = 'FABRIC_DELEGATION_PAIR_INVITATION';
/** The user saw the same code on both screens: `{ scopes }`. */
export const DELEGATION_PAIR_CONFIRM = 'FABRIC_DELEGATION_PAIR_CONFIRM';
export const DELEGATION_PAIR_CANCEL = 'FABRIC_DELEGATION_PAIR_CANCEL';
/** The open pairing (polled by the popup while it shows). */
export const DELEGATION_PAIRING_GET = 'FABRIC_DELEGATION_PAIRING_GET';
/** Withdraw a grant this Passport gave: `{ hash }`. */
export const DELEGATION_REVOKE = 'FABRIC_DELEGATION_REVOKE';
/** Forget a linked signer and revoke every grant it holds: `{ pubkey }`. */
export const DELEGATION_FORGET = 'FABRIC_DELEGATION_FORGET';
/** Answer a pending request: `{ hash, action: 'sign'|'decline', frame? }`. */
export const DELEGATION_ANSWER = 'FABRIC_DELEGATION_ANSWER';
/** Ask a linked signer to sign a frame: `{ target, request, purpose? }`. */
export const DELEGATION_ASK = 'FABRIC_DELEGATION_ASK';
/** Collect waiting frames from the mailboxes now. */
export const DELEGATION_POLL = 'FABRIC_DELEGATION_POLL';

/** chrome.storage.session: the open pairing as the popup shows it (no secrets). */
export const DELEGATION_PAIRING_SESSION_KEY = 'fabric.delegation.pairing';
/** chrome.storage.session: request hash the popup should open on (set by a notification click). */
export const DELEGATION_FOCUS_SESSION_KEY = 'fabric.delegation.focus';

/** chrome.alarms name for collecting mailbox frames. */
export const DELEGATION_ALARM = 'fabric_delegation_mailbox';

/** Notification id prefix for delegation requests (`delegation:<hash>`). */
export const DELEGATION_NOTIFICATION_PREFIX = 'delegation:';

/** Scopes Passport can grant, with the words its prompts use. */
export const DELEGATION_SCOPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  identity: 'Treat it as me (link our identities)',
  passport: 'Ask me to sign in to sites for it',
  federation: 'Invite me to shared wallets and ask me to co-sign',
  message: 'Ask me to sign messages'
});

/** Notification id prefix for a site sign-in waiting in the popup. */
export const SIGN_IN_NOTIFICATION_PREFIX = 'passport-sign-in:';
