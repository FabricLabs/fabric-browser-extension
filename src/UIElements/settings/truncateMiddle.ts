'use strict';

export function truncateMiddle (str: string | undefined, frontLen: number = 5, backLen: number = 5): string {
  if (!str) return '';
  if (str.length <= frontLen + backLen) return str;
  return `${str.slice(0, frontLen)}...${str.slice(-backLen)}`;
}
