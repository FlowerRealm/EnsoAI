import type { WindowBootstrapContext } from '@shared/types';
import { BrowserWindow, type WebContents } from 'electron';

const LOCAL_CONTEXT: WindowBootstrapContext = { mode: 'local' };

export class WindowContextManager {
  private readonly contexts = new Map<number, WindowBootstrapContext>();

  registerWindow(window: BrowserWindow, context: WindowBootstrapContext): void {
    this.contexts.set(window.id, context);
    window.once('closed', () => {
      this.contexts.delete(window.id);
    });
  }

  setWindowContext(window: BrowserWindow, context: WindowBootstrapContext): void {
    this.contexts.set(window.id, context);
  }

  getWindowContext(window: BrowserWindow | null | undefined): WindowBootstrapContext {
    if (!window) {
      return LOCAL_CONTEXT;
    }
    return this.contexts.get(window.id) ?? LOCAL_CONTEXT;
  }

  getWindowContextFromSender(sender: WebContents): WindowBootstrapContext {
    return this.getWindowContext(BrowserWindow.fromWebContents(sender));
  }
}

export const windowContextManager = new WindowContextManager();
