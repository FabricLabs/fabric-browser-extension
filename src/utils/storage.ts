'use strict';

const STORAGE_KEY = 'fabric_identities';

export const Storage = {
  async getIdentities (): Promise<unknown[]> {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  },

  async saveIdentities (identities: unknown[]): Promise<void> {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identities));
  }
};
