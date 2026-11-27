'use strict';

/** Minutes of inactivity before Passport locks. 0 leaves it unlocked. */
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

export const MAX_AUTO_LOCK_MINUTES = 720;

export function clampAutoLockMinutes (value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_LOCK_MINUTES;
  return Math.max(0, Math.min(MAX_AUTO_LOCK_MINUTES, Math.trunc(value)));
}
