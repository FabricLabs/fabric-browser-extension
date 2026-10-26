'use strict';

import { useEffect, useState } from 'react';

/** Delay before Approve works again after what the prompt shows changes. */
export const APPROVE_ARM_DELAY_MS = 1000;

/**
 * False for `ms` after `key` changes (and on mount), then true, so a click
 * aimed at the old content — or at the window as it opens — can't approve
 * the new one.
 */
export function useArmDelay (key: string, ms: number = APPROVE_ARM_DELAY_MS): boolean {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  useEffect(() => {
    setArmedKey(null);
    const timer = setTimeout(() => setArmedKey(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return armedKey === key;
}
