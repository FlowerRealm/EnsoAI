import type { RemoteWindowSession, WindowBootstrapContext } from '@shared/types';

let bootstrapContext: WindowBootstrapContext = { mode: 'local' };
let activeRemoteSession: RemoteWindowSession | null = null;
let patchInstalled = false;
let suppressSync = false;
let syncTimer: number | null = null;

function snapshotLocalStorage(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key) {
      continue;
    }
    const value = window.localStorage.getItem(key);
    if (value !== null) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function applyLocalStorageSnapshot(snapshot: Record<string, string>): void {
  suppressSync = true;
  try {
    const existingKeys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) {
        existingKeys.push(key);
      }
    }

    for (const key of existingKeys) {
      if (!(key in snapshot)) {
        window.localStorage.removeItem(key);
      }
    }

    for (const [key, value] of Object.entries(snapshot)) {
      window.localStorage.setItem(key, value);
    }
  } finally {
    suppressSync = false;
  }
}

function scheduleRemoteLocalStorageSync(): void {
  if (!activeRemoteSession || suppressSync) {
    return;
  }

  if (syncTimer !== null) {
    window.clearTimeout(syncTimer);
  }

  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    if (!activeRemoteSession || suppressSync) {
      return;
    }
    window.electronAPI.remote
      .syncSessionLocalStorage(snapshotLocalStorage())
      .catch((error) => console.warn('[remote-session] Failed to sync localStorage:', error));
  }, 150);
}

function installLocalStoragePatch(): void {
  if (patchInstalled) {
    return;
  }
  patchInstalled = true;

  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  const clear = Storage.prototype.clear;

  Storage.prototype.setItem = function patchedSetItem(key: string, value: string): void {
    setItem.call(this, key, value);
    if (this === window.localStorage) {
      scheduleRemoteLocalStorageSync();
    }
  };

  Storage.prototype.removeItem = function patchedRemoveItem(key: string): void {
    removeItem.call(this, key);
    if (this === window.localStorage) {
      scheduleRemoteLocalStorageSync();
    }
  };

  Storage.prototype.clear = function patchedClear(): void {
    clear.call(this);
    if (this === window.localStorage) {
      scheduleRemoteLocalStorageSync();
    }
  };

  window.addEventListener('beforeunload', () => {
    if (!activeRemoteSession || suppressSync) {
      return;
    }
    void window.electronAPI.remote.syncSessionLocalStorage(snapshotLocalStorage());
  });
}

export async function bootstrapRemoteSessionState(): Promise<void> {
  installLocalStoragePatch();

  bootstrapContext = await window.electronAPI.window.getContext();
  activeRemoteSession = bootstrapContext.mode === 'remote-host' ? bootstrapContext.session : null;

  if (!activeRemoteSession) {
    return;
  }

  const sessionState = await window.electronAPI.remote.getSession();
  if (sessionState) {
    activeRemoteSession = sessionState.session;
    applyLocalStorageSnapshot(sessionState.localStorage);
  }
}

export function getBootstrappedRemoteSession(): RemoteWindowSession | null {
  return activeRemoteSession;
}

export function getWindowBootstrapContext(): WindowBootstrapContext {
  return bootstrapContext;
}
