import type { McpServer } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  deleteMcpServer,
  readMcpServers,
  serverToConfig,
  syncMcpServers,
  upsertMcpServer,
} from '../services/claude/McpManager';
import {
  addMarketplace,
  getAvailablePlugins,
  getMarketplaces,
  getPlugins,
  installPlugin,
  refreshMarketplaces,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from '../services/claude/PluginsManager';
import { backupClaudeMd, readClaudeMd, writeClaudeMd } from '../services/claude/PromptsManager';
import { remoteSessionManager } from '../services/remote/RemoteSessionManager';

async function readRemoteMcpServers(sender: Electron.WebContents) {
  const data =
    (await remoteSessionManager.readRemoteJsonFile<{
      mcpServers?: Record<string, import('@shared/types').McpServerConfig>;
    }>(sender, remoteSessionManager.getClaudeJsonPath(sender))) ?? {};
  return data.mcpServers ?? {};
}

async function writeRemoteMcpServers(
  sender: Electron.WebContents,
  nextServers: Record<string, import('@shared/types').McpServerConfig>
) {
  const data =
    (await remoteSessionManager.readRemoteJsonFile<Record<string, unknown>>(
      sender,
      remoteSessionManager.getClaudeJsonPath(sender)
    )) ?? {};
  return remoteSessionManager.writeRemoteJsonFile(
    sender,
    remoteSessionManager.getClaudeJsonPath(sender),
    {
      ...data,
      mcpServers: nextServers,
    }
  );
}

export function registerClaudeConfigHandlers(): void {
  // MCP Management
  ipcMain.handle(IPC_CHANNELS.CLAUDE_MCP_READ, async (event) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return readRemoteMcpServers(event.sender);
    }
    return readMcpServers();
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_MCP_SYNC, async (event, servers: McpServer[]) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      const mcpServers: Record<string, import('@shared/types').McpServerConfig> = {};
      for (const server of servers) {
        if (!server.enabled) continue;
        const config = serverToConfig(server);
        if (config) {
          mcpServers[server.id] = config;
        }
      }
      return writeRemoteMcpServers(event.sender, mcpServers);
    }
    return syncMcpServers(servers);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_MCP_UPSERT, async (event, server: McpServer) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      const existing = await readRemoteMcpServers(event.sender);
      const next = { ...existing };
      if (server.enabled) {
        const config = serverToConfig(server);
        if (config) {
          next[server.id] = config;
        }
      } else {
        delete next[server.id];
      }
      return writeRemoteMcpServers(event.sender, next);
    }
    return upsertMcpServer(server);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_MCP_DELETE, async (event, serverId: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      const existing = await readRemoteMcpServers(event.sender);
      const next = { ...existing };
      delete next[serverId];
      return writeRemoteMcpServers(event.sender, next);
    }
    return deleteMcpServer(serverId);
  });

  // Prompts Management
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PROMPTS_READ, async (event) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return remoteSessionManager.readRemoteTextFile(
        event.sender,
        remoteSessionManager.getClaudePromptPath(event.sender)
      );
    }
    return readClaudeMd();
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_PROMPTS_WRITE, async (event, content: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return remoteSessionManager.writeRemoteTextFile(
        event.sender,
        remoteSessionManager.getClaudePromptPath(event.sender),
        content
      );
    }
    return writeClaudeMd(content);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_PROMPTS_BACKUP, async (event) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      const content = await remoteSessionManager.readRemoteTextFile(
        event.sender,
        remoteSessionManager.getClaudePromptPath(event.sender)
      );
      if (content === null) {
        return null;
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${remoteSessionManager.getClaudeConfigDir(event.sender)}/backups/CLAUDE.md.${timestamp}.bak`;
      const success = await remoteSessionManager.writeRemoteTextFile(
        event.sender,
        backupPath,
        content
      );
      return success ? backupPath : null;
    }
    return backupClaudeMd();
  });

  // Plugins Management
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLUGINS_LIST, (event) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return [];
    }
    return getPlugins();
  });

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_SET_ENABLED,
    (event, pluginId: string, enabled: boolean) => {
      if (remoteSessionManager.hasSession(event.sender)) {
        return false;
      }
      return setPluginEnabled(pluginId, enabled);
    }
  );

  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLUGINS_AVAILABLE, (event, marketplace?: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return [];
    }
    return getAvailablePlugins(marketplace);
  });

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PLUGINS_INSTALL,
    (event, pluginName: string, marketplace?: string) => {
      if (remoteSessionManager.hasSession(event.sender)) {
        return false;
      }
      return installPlugin(pluginName, marketplace);
    }
  );

  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLUGINS_UNINSTALL, (event, pluginId: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return false;
    }
    return uninstallPlugin(pluginId);
  });

  // Marketplaces Management
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_LIST, (event) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return [];
    }
    return getMarketplaces();
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_ADD, (event, repo: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return false;
    }
    return addMarketplace(repo);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_REMOVE, (event, name: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return false;
    }
    return removeMarketplace(name);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLUGINS_MARKETPLACES_REFRESH, (event, name?: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return false;
    }
    return refreshMarketplaces(name);
  });
}
