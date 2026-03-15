import type { ConnectionProfile, RemoteWindowOpenTarget } from '@shared/types';
import { BrowserWindow, type WebContents } from 'electron';
import { remoteSessionManager } from '../services/remote/RemoteSessionManager';
import { confirmWindowReplace, createMainWindow } from './MainWindow';

function resolveWindow(
  target: BrowserWindow | WebContents | null | undefined
): BrowserWindow | null {
  if (!target) {
    return null;
  }

  if ('webContents' in target) {
    return target;
  }

  return BrowserWindow.fromWebContents(target);
}

export function openLocalWindow(options?: { replaceWindow?: BrowserWindow | null }): BrowserWindow {
  return createMainWindow({
    context: { mode: 'local' },
    replaceWindow: options?.replaceWindow ?? null,
  });
}

export async function openRemoteHostWindow(options: {
  profileOrId: string | ConnectionProfile;
  target: RemoteWindowOpenTarget;
  sourceWindow?: BrowserWindow | WebContents | null;
}): Promise<BrowserWindow | null> {
  const replaceWindow =
    options.target === 'current-window' ? resolveWindow(options.sourceWindow) : null;

  if (options.target === 'current-window') {
    if (!replaceWindow) {
      throw new Error('当前窗口不可用');
    }

    const confirmed = await confirmWindowReplace(replaceWindow);
    if (!confirmed) {
      return null;
    }
  }

  const sessionState = await remoteSessionManager.openSession(options.profileOrId);

  return createMainWindow({
    context: { mode: 'remote-host', session: sessionState.session },
    partition: `enso-remote-window:${sessionState.session.sessionId}`,
    replaceWindow,
    initializeWindow: (window) => remoteSessionManager.attachToWindow(window, sessionState),
  });
}

export async function disconnectRemoteWindow(
  target: BrowserWindow | WebContents
): Promise<BrowserWindow | null> {
  const window = resolveWindow(target);
  if (!window) {
    throw new Error('远程窗口不可用');
  }

  const confirmed = await confirmWindowReplace(window);
  if (!confirmed) {
    return null;
  }

  await remoteSessionManager.closeSession(window);
  return openLocalWindow({ replaceWindow: window });
}
