declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys: string | string[] | null): Promise<{ [key: string]: unknown }>;
      get(keys: string | string[] | null, callback: (items: { [key: string]: unknown }) => void): void;
      set(items: { [key: string]: unknown }): Promise<void>;
      set(items: { [key: string]: unknown }, callback?: () => void): void;
      remove(keys: string | string[]): Promise<void>;
      remove(keys: string | string[], callback?: () => void): void;
    }

    const local: StorageArea;
  }

  namespace runtime {
    interface MessageSender {
      id?: string;
      url?: string;
      tab?: chrome.tabs.Tab;
      frameId?: number;
    }

    interface MessageEvent {
      type: string;
      [key: string]: unknown;
    }

    const onInstalled: {
      addListener(callback: () => void): void;
    };

    const onMessage: {
      addListener(callback: (message: MessageEvent, sender: MessageSender, sendResponse: (response?: unknown) => void) => void | boolean): void;
    };
  }
} 