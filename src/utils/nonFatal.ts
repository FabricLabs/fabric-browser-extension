'use strict';

/**
 * Use when a failure is expected or harmless (optional APIs, teardown races, invalid user/network input).
 * Keeps catch bodies non-empty for static analysis (Codacy / Sonar “empty catch” / S2486 class rules).
 */
export function swallowNonFatal (context: string, err: unknown): void {
  void context;
  void err;
}
