'use strict';

const STORAGE_KEY = 'fabric_identities';

export const Storage = {
  async getIdentities (): Promise<any[]> {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  },

  async saveIdentities (identities: any[]): Promise<void> {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identities));
  }
}; 