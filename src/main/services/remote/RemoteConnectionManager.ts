import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConnectionProfile,
  ConnectionTestResult,
  RemoteAuthResponse,
  RemoteConnectionStatus,
  RemoteHelperStatus,
  RemoteHostFingerprint,
  RemotePlatform,
} from '@shared/types';
import { app } from 'electron';
import { getEnvForCommand } from '../../utils/shell';
import { RemoteAuthBroker } from './RemoteAuthBroker';
import { getRemoteHelperSource, REMOTE_HELPER_VERSION } from './RemoteHelperSource';
import { createRemoteError, translateRemote } from './RemoteI18n';

interface HelperProcess {
  connectionId: string;
  profile: ConnectionProfile;
  proc: import('node:child_process').ChildProcessWithoutNullStreams;
  nextRequestId: number;
  pending: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >;
  buffer: string;
  closed: boolean;
  status: RemoteConnectionStatus;
}

interface ResolvedHostConfig {
  host: string;
  port: number;
  knownHost: string;
  userKnownHostsFiles: string[];
  globalKnownHostsFiles: string[];
}

interface ConnectionRuntime {
  platform: RemotePlatform;
  homeDir: string;
  nodeVersion: string;
  gitVersion: string;
  resolvedHost: ResolvedHostConfig;
}

interface SshContext {
  env: Record<string, string>;
  optionArgs: string[];
}

interface LocalCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface HelperInstallPaths {
  helperInstallDir: string;
  helperDir: string;
  helperPath: string;
}

interface HelperEnvironmentInfo {
  platform: RemotePlatform;
  homeDir: string;
  nodeVersion: string;
  gitVersion: string;
}

interface RemoteDirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

type RemoteEventListener = (payload: unknown) => void;

const DEFAULT_HELPER_DIR = '.ensoai/remote-helper';
const HELPER_FILENAME = 'enso-remote-helper.cjs';
const HELPER_BOOTSTRAP_TIMEOUT_MS = 5_000;
const REMOTE_SETTINGS_PATH = 'remote-connections.json';
const REMOTE_KNOWN_HOSTS_PATH = 'remote-known_hosts';
const SSH_KEYSCAN_TIMEOUT_SECONDS = 5;

function now() {
  return Date.now();
}

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

function normalizeRemotePath(input: string): string {
  const replaced = input.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (/^[A-Za-z]:$/.test(replaced)) {
    return `${replaced}/`;
  }
  return replaced || '/';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isVersionDirectoryName(name: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(name);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getRemoteSettingsPath(): string {
  return join(app.getPath('userData'), REMOTE_SETTINGS_PATH);
}

function getRemoteStateRoot(): string {
  return join(process.env.HOME || process.env.USERPROFILE || app.getPath('home'), '.ensoai');
}

function getAppKnownHostsPath(): string {
  return join(getRemoteStateRoot(), REMOTE_KNOWN_HOSTS_PATH);
}

function buildPosixNodeWriteCommand(targetPath: string, content: string): string {
  const source = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(targetPath)}, Buffer.from(${JSON.stringify(content)}, 'base64'));`,
  ].join(' ');
  return `node -e ${shellQuote(source)}`;
}

function expandHomePath(input: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    return input;
  }
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(home, input.slice(2));
  }
  return input;
}

function parseSshConfig(stdout: string): Map<string, string[]> {
  const config = new Map<string, string[]>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const firstSpace = line.indexOf(' ');
    if (firstSpace <= 0) continue;
    const key = line.slice(0, firstSpace).toLowerCase();
    const value = line.slice(firstSpace + 1).trim();
    if (!value) continue;
    if (key === 'userknownhostsfile' || key === 'globalknownhostsfile') {
      config.set(
        key,
        value
          .split(/\s+/)
          .map((entry) => expandHomePath(entry))
          .filter(Boolean)
      );
      continue;
    }
    config.set(key, [value]);
  }
  return config;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function getKnownHostQueries(host: string, port: number): string[] {
  const results = [`[${host}]:${port}`];
  if (port === 22) {
    results.unshift(host);
  }
  return results;
}

function formatKnownHostEntryHost(host: string, port: number): string {
  if (port !== 22 || host.includes(':')) {
    return `[${host}]:${port}`;
  }
  return host;
}

function normalizeScannedKnownHostsEntries(
  scannedKeys: string,
  knownHost: string,
  port: number
): string {
  const hostField = formatKnownHostEntryHost(knownHost, port);
  return scannedKeys
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) {
        return null;
      }
      return `${hostField} ${parts[1]} ${parts[2]}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

function parseFingerprintLine(
  line: string,
  host: string,
  port: number
): RemoteHostFingerprint | null {
  const match = line.trim().match(/^(\d+)\s+(\S+)\s+.+\(([^)]+)\)$/);
  if (!match) {
    return null;
  }
  return {
    host,
    port,
    bits: Number.parseInt(match[1], 10),
    fingerprint: match[2],
    keyType: match[3],
  };
}

function isAuthenticationFailure(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes('permission denied') ||
    normalized.includes('authentication failed') ||
    normalized.includes('too many authentication failures') ||
    normalized.includes('sign_and_send_pubkey') ||
    normalized.includes('load key')
  );
}

async function runLocalCommand(
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<LocalCommandResult> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env ? { ...getEnvForCommand(), ...env } : getEnvForCommand(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

export class RemoteConnectionManager {
  private profiles = new Map<string, ConnectionProfile>();
  private helpers = new Map<string, HelperProcess>();
  private pendingConnections = new Map<string, Promise<RemoteConnectionStatus>>();
  private runtimes = new Map<string, ConnectionRuntime>();
  private readonly authBroker = new RemoteAuthBroker();
  private loaded = false;

  async loadProfiles(): Promise<ConnectionProfile[]> {
    if (this.loaded) {
      return this.listProfiles();
    }
    const path = getRemoteSettingsPath();
    if (await pathExists(path)) {
      try {
        const content = await readFile(path, 'utf8');
        const parsed = JSON.parse(content) as ConnectionProfile[];
        for (const profile of parsed) {
          this.profiles.set(profile.id, profile);
        }
      } catch (error) {
        console.warn('[remote] Failed to read profiles:', error);
      }
    }
    this.loaded = true;
    return this.listProfiles();
  }

  listProfiles(): ConnectionProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveProfile(
    input: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>>
  ): Promise<ConnectionProfile> {
    await this.loadProfiles();
    const existing = input.id ? this.profiles.get(input.id) : null;
    const profile: ConnectionProfile = {
      id: input.id ?? randomUUID(),
      name: input.name.trim(),
      sshTarget: input.sshTarget.trim(),
      helperInstallDir: input.helperInstallDir?.trim() || undefined,
      platformHint: input.platformHint,
      createdAt: existing?.createdAt ?? input.createdAt ?? now(),
      updatedAt: now(),
    };
    this.profiles.set(profile.id, profile);
    this.runtimes.delete(profile.id);
    this.authBroker.clearSecrets(profile.id);
    await this.flush();
    return profile;
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.loadProfiles();
    await this.disconnect(profileId).catch(() => {});
    this.profiles.delete(profileId);
    this.runtimes.delete(profileId);
    this.authBroker.clearSecrets(profileId);
    await this.flush();
  }

  getStatus(connectionId: string): RemoteConnectionStatus {
    return (
      this.helpers.get(connectionId)?.status ?? {
        connectionId,
        connected: false,
      }
    );
  }

  async testConnection(profileOrId: string | ConnectionProfile): Promise<ConnectionTestResult> {
    const profile = await this.resolveProfile(profileOrId);
    try {
      const runtime = await this.resolveRuntime(profile, true);
      return {
        success: true,
        platform: runtime.platform,
        homeDir: runtime.homeDir,
        nodeVersion: runtime.nodeVersion,
        gitVersion: runtime.gitVersion,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getHelperStatus(profileOrId: string | ConnectionProfile): Promise<RemoteHelperStatus> {
    const profile = await this.resolveProfile(profileOrId);
    const connected = this.helpers.get(profile.id)?.status.connected ?? false;

    try {
      const runtime = await this.resolveRuntime(profile, false);
      const helperPaths = this.getHelperInstallPaths(profile, runtime);
      const installedVersions = await this.listInstalledHelperVersions(
        profile,
        runtime,
        helperPaths
      );
      return {
        connectionId: profile.id,
        installed: installedVersions.length > 0,
        installDir: helperPaths.helperInstallDir,
        installedVersions,
        currentVersion: REMOTE_HELPER_VERSION,
        connected,
        lastCheckedAt: now(),
      };
    } catch (error) {
      const helperInstallDir = profile.helperInstallDir?.trim()
        ? normalizeRemotePath(profile.helperInstallDir)
        : DEFAULT_HELPER_DIR;
      return {
        connectionId: profile.id,
        installed: false,
        installDir: helperInstallDir,
        installedVersions: [],
        currentVersion: REMOTE_HELPER_VERSION,
        connected,
        error: error instanceof Error ? error.message : String(error),
        lastCheckedAt: now(),
      };
    }
  }

  async installHelperManually(
    profileOrId: string | ConnectionProfile
  ): Promise<RemoteHelperStatus> {
    const profile = await this.resolveProfile(profileOrId);
    const runtime = await this.resolveRuntime(profile, false);
    const helperPaths = this.getHelperInstallPaths(profile, runtime);
    await this.installHelper(profile, runtime, helperPaths);
    return this.getHelperStatus(profile);
  }

  async updateHelper(profileOrId: string | ConnectionProfile): Promise<RemoteHelperStatus> {
    const profile = await this.resolveProfile(profileOrId);
    await this.disconnect(profile.id).catch(() => {});
    const runtime = await this.resolveRuntime(profile, false);
    const helperPaths = this.getHelperInstallPaths(profile, runtime);
    await this.installHelper(profile, runtime, helperPaths);
    await this.cleanupOldHelperVersionsOnHost(profile, runtime, helperPaths);
    return this.getHelperStatus(profile);
  }

  async deleteHelper(profileOrId: string | ConnectionProfile): Promise<RemoteHelperStatus> {
    const profile = await this.resolveProfile(profileOrId);
    await this.disconnect(profile.id).catch(() => {});
    const runtime = await this.resolveRuntime(profile, false);
    const helperPaths = this.getHelperInstallPaths(profile, runtime);
    await this.deleteInstalledHelperVersions(profile, runtime, helperPaths);
    return this.getHelperStatus(profile);
  }

  async connect(profileOrId: string | ConnectionProfile): Promise<RemoteConnectionStatus> {
    const profile = await this.resolveProfile(profileOrId);
    const existing = this.helpers.get(profile.id);
    if (existing) {
      return existing.status;
    }

    const pending = this.pendingConnections.get(profile.id);
    if (pending) {
      return pending;
    }

    const connectionAttempt = this.establishHelperConnection(profile).finally(() => {
      if (this.pendingConnections.get(profile.id) === connectionAttempt) {
        this.pendingConnections.delete(profile.id);
      }
    });

    this.pendingConnections.set(profile.id, connectionAttempt);
    return connectionAttempt;
  }

  async disconnect(connectionId: string): Promise<void> {
    const helper = this.helpers.get(connectionId);
    if (!helper) return;
    helper.proc.kill('SIGTERM');
    this.helpers.delete(connectionId);
  }

  async browseRoots(profileOrId: string | ConnectionProfile): Promise<string[]> {
    const profile = await this.resolveProfile(profileOrId);
    const runtime = await this.resolveRuntime(profile, false);
    if (runtime.platform === 'win32') {
      return [runtime.homeDir.replace(/\\/g, '/')];
    }
    return ['/', runtime.homeDir.replace(/\\/g, '/')];
  }

  async getTerminalSshOptions(
    connectionId: string,
    remoteCommand: string
  ): Promise<{ args: string[]; env: Record<string, string> }> {
    const profile = await this.resolveProfile(connectionId);
    const runtime = await this.resolveRuntime(profile, false);
    const sshContext = await this.buildSshContext(profile, runtime.resolvedHost);
    return {
      args: [...sshContext.optionArgs, '-tt', profile.sshTarget, remoteCommand],
      env: sshContext.env,
    };
  }

  respondAuthPrompt(response: RemoteAuthResponse): boolean {
    return this.authBroker.respond(response);
  }

  async call<T = unknown>(
    connectionId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const helper = this.helpers.get(connectionId) ?? (await this.ensureConnected(connectionId));
    return this.callHelper<T>(helper, method, params);
  }

  async addEventListener(
    connectionId: string,
    event: string,
    listener: RemoteEventListener
  ): Promise<() => void> {
    const helper = this.helpers.get(connectionId) ?? (await this.ensureConnected(connectionId));
    helper.proc.on(event, listener);
    return () => {
      helper.proc.off(event, listener);
    };
  }

  async cleanup(): Promise<void> {
    const ids = [...this.helpers.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
    await this.authBroker.dispose();
  }

  private async ensureConnected(connectionId: string): Promise<HelperProcess> {
    await this.connect(connectionId);
    const helper = this.helpers.get(connectionId);
    if (!helper) {
      throw createRemoteError('Failed to establish remote helper for {{connectionId}}', {
        connectionId,
      });
    }
    return helper;
  }

  private async establishHelperConnection(
    profile: ConnectionProfile
  ): Promise<RemoteConnectionStatus> {
    const runtime = await this.resolveRuntime(profile, false);
    const helperPaths = this.getHelperInstallPaths(profile, runtime);

    try {
      return await this.startConnectedHelper(profile, runtime, helperPaths);
    } catch (reuseError) {
      const detail = reuseError instanceof Error ? reuseError.message : String(reuseError);
      console.warn(
        `[remote:${profile.name}] Failed to reuse helper, reinstalling current version: ${detail}`
      );
    }

    await this.installHelper(profile, runtime, helperPaths);
    return this.startConnectedHelper(profile, runtime, helperPaths);
  }

  private getHelperInstallPaths(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime
  ): HelperInstallPaths {
    const helperInstallDir = normalizeRemotePath(
      profile.helperInstallDir?.trim() ||
        `${runtime.homeDir.replace(/\\/g, '/')}/${DEFAULT_HELPER_DIR}`
    );
    const helperDir = normalizeRemotePath(`${helperInstallDir}/${REMOTE_HELPER_VERSION}`);
    return {
      helperInstallDir,
      helperDir,
      helperPath: normalizeRemotePath(`${helperDir}/${HELPER_FILENAME}`),
    };
  }

  private async installHelper(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    helperPaths: HelperInstallPaths
  ): Promise<void> {
    await this.execSsh(
      profile,
      [
        runtime.platform === 'win32'
          ? `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${helperPaths.helperDir.replace(/'/g, "''")}' | Out-Null"`
          : `mkdir -p ${shellQuote(helperPaths.helperDir)}`,
      ],
      runtime.resolvedHost
    );

    const helperSource = normalizeLineEndings(getRemoteHelperSource());
    const encoded = Buffer.from(helperSource, 'utf8').toString('base64');
    const writeCommand =
      runtime.platform === 'win32'
        ? [
            'powershell',
            '-NoProfile',
            '-Command',
            `[IO.File]::WriteAllBytes('${helperPaths.helperPath.replace(/'/g, "''")}', [Convert]::FromBase64String('${encoded}'))`,
          ]
        : [buildPosixNodeWriteCommand(helperPaths.helperPath, encoded)];
    await this.execSsh(profile, writeCommand, runtime.resolvedHost);

    if (runtime.platform !== 'win32') {
      await this.execSsh(
        profile,
        [`chmod +x ${shellQuote(helperPaths.helperPath)}`],
        runtime.resolvedHost
      );
    }
  }

  private async startConnectedHelper(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    helperPaths: HelperInstallPaths
  ): Promise<RemoteConnectionStatus> {
    const helper = await this.spawnHelperProcess(profile, runtime, helperPaths.helperPath);
    try {
      const envInfo = await this.callHelper<HelperEnvironmentInfo>(
        helper,
        'env:test',
        {},
        HELPER_BOOTSTRAP_TIMEOUT_MS
      );
      helper.status = {
        ...helper.status,
        connected: true,
        error: undefined,
        platform: envInfo.platform,
        lastCheckedAt: now(),
      };
      this.helpers.set(profile.id, helper);
      void this.cleanupOldHelperVersions(helper, helperPaths).catch((error) => {
        console.warn(
          `[remote:${profile.name}] Failed to clean up old helper versions: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
      return helper.status;
    } catch (error) {
      helper.proc.kill('SIGTERM');
      throw error;
    }
  }

  private async spawnHelperProcess(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    helperPath: string
  ): Promise<HelperProcess> {
    const { spawn } = await import('node:child_process');
    const helperCommand =
      runtime.platform === 'win32'
        ? `node "${helperPath.replace(/\//g, '\\')}" --stdio`
        : `node ${shellQuote(helperPath)} --stdio`;
    const sshContext = await this.buildSshContext(profile, runtime.resolvedHost);
    const proc = spawn('ssh', [...sshContext.optionArgs, profile.sshTarget, helperCommand], {
      env: sshContext.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const helper: HelperProcess = {
      connectionId: profile.id,
      profile,
      proc,
      nextRequestId: 1,
      pending: new Map(),
      buffer: '',
      closed: false,
      status: {
        connectionId: profile.id,
        connected: false,
        helperVersion: REMOTE_HELPER_VERSION,
        platform: runtime.platform,
        lastCheckedAt: now(),
      },
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      helper.buffer += chunk;
      const lines = helper.buffer.split('\n');
      helper.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: {
          type?: string;
          id?: number;
          result?: unknown;
          error?: string;
          event?: string;
          payload?: unknown;
        };
        try {
          message = JSON.parse(line);
        } catch (error) {
          console.warn('[remote] Failed to parse helper output:', error);
          continue;
        }
        if (message.type === 'response' && typeof message.id === 'number') {
          const pending = helper.pending.get(message.id);
          if (!pending) continue;
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message.result);
          }
        } else if (message.type === 'event' && message.event) {
          helper.proc.emit(`remote:${message.event}`, message.payload);
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (!text) {
        return;
      }
      if (isAuthenticationFailure(text)) {
        this.authBroker.clearSecrets(profile.id);
      }
      console.warn(`[remote:${profile.name}] ${text}`);
    });

    proc.on('error', (error) => {
      this.finalizeHelperShutdown(helper, error.message);
    });

    proc.on('exit', (code, signal) => {
      this.finalizeHelperShutdown(
        helper,
        code === 0
          ? undefined
          : translateRemote('Remote helper exited ({{reason}})', {
              reason: `${code ?? 'signal'}${signal ? `/${signal}` : ''}`,
            })
      );
    });

    return helper;
  }

  private finalizeHelperShutdown(helper: HelperProcess, error?: string): void {
    if (helper.closed) {
      return;
    }
    helper.closed = true;
    helper.status = {
      ...helper.status,
      connected: false,
      error,
      lastCheckedAt: now(),
    };
    for (const pending of helper.pending.values()) {
      pending.reject(
        new Error(helper.status.error || translateRemote('Remote helper disconnected'))
      );
    }
    helper.pending.clear();
    if (this.helpers.get(helper.connectionId) === helper) {
      this.helpers.delete(helper.connectionId);
    }
  }

  private async callHelper<T = unknown>(
    helper: HelperProcess,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    const id = helper.nextRequestId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        helper.pending.delete(id);
        callback();
      };

      helper.pending.set(id, {
        resolve: (value) => finish(() => resolve(value as T)),
        reject: (error) => finish(() => reject(error)),
      });

      helper.proc.stdin.write(`${payload}\n`, 'utf8', (error) => {
        if (error) {
          finish(() => reject(error));
        }
      });

      if (timeoutMs) {
        timeout = setTimeout(() => {
          finish(() => reject(new Error(translateRemote('Remote helper bootstrap timed out'))));
        }, timeoutMs);
      }
    });
  }

  private async cleanupOldHelperVersions(
    helper: HelperProcess,
    helperPaths: HelperInstallPaths
  ): Promise<void> {
    const runtime = await this.resolveRuntime(helper.profile, false);
    await this.cleanupOldHelperVersionsOnHost(helper.profile, runtime, helperPaths, helper);
  }

  private async cleanupOldHelperVersionsOnHost(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    helperPaths: HelperInstallPaths,
    helper?: HelperProcess
  ): Promise<void> {
    const entries = await this.listHelperDirectories(profile, runtime, helperPaths, helper);

    for (const entry of entries) {
      if (entry.name === REMOTE_HELPER_VERSION) {
        continue;
      }

      await this.deleteHelperDirectory(profile, runtime, entry.path, helper);
    }
  }

  private async listInstalledHelperVersions(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    helperPaths: HelperInstallPaths
  ): Promise<string[]> {
    const entries = await this.listHelperDirectories(profile, runtime, helperPaths);
    return entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  }

  private async deleteInstalledHelperVersions(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    helperPaths: HelperInstallPaths
  ): Promise<void> {
    const entries = await this.listHelperDirectories(profile, runtime, helperPaths);
    for (const entry of entries) {
      await this.deleteHelperDirectory(profile, runtime, entry.path);
    }
  }

  private async listHelperDirectories(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    helperPaths: HelperInstallPaths,
    helper?: HelperProcess
  ): Promise<RemoteDirectoryEntry[]> {
    const entries = helper
      ? await this.callHelper<RemoteDirectoryEntry[]>(helper, 'fs:list', {
          path: helperPaths.helperInstallDir,
        })
      : await this.listRemoteDirectory(profile, runtime, helperPaths.helperInstallDir);

    const helperDirectories: RemoteDirectoryEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory || !isVersionDirectoryName(entry.name)) {
        continue;
      }
      const helperFilePath = normalizeRemotePath(`${entry.path}/${HELPER_FILENAME}`);
      const helperFileExists = helper
        ? await this.callHelper<boolean>(helper, 'fs:exists', {
            path: helperFilePath,
          })
        : await this.remoteFileExists(profile, runtime, helperFilePath);
      if (!helperFileExists) {
        continue;
      }
      helperDirectories.push({
        name: entry.name,
        path: normalizeRemotePath(entry.path),
        isDirectory: true,
      });
    }

    return helperDirectories;
  }

  private async deleteHelperDirectory(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    directoryPath: string,
    helper?: HelperProcess
  ): Promise<void> {
    if (helper) {
      await this.callHelper(helper, 'fs:delete', {
        path: directoryPath,
        recursive: true,
      });
      return;
    }

    await this.deleteRemotePath(profile, runtime, directoryPath);
  }

  private async listRemoteDirectory(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    dirPath: string
  ): Promise<RemoteDirectoryEntry[]> {
    const command =
      runtime.platform === 'win32'
        ? [
            'powershell',
            '-NoProfile',
            '-Command',
            [
              `$dir = ${this.toPowerShellString(dirPath)}`,
              'if (-not (Test-Path -LiteralPath $dir)) { Write-Output "[]"; exit 0 }',
              '$entries = Get-ChildItem -LiteralPath $dir -Force | ForEach-Object {',
              '  [PSCustomObject]@{',
              '    name = $_.Name',
              "    path = ($_.FullName -replace '\\\\', '/')",
              '    isDirectory = $_.PSIsContainer',
              '  }',
              '}',
              '$entries | ConvertTo-Json -Compress',
            ].join('; '),
          ]
        : [
            `node -e ${shellQuote(
              [
                "const fs = require('node:fs');",
                `const dir = ${JSON.stringify(dirPath)};`,
                "if (!fs.existsSync(dir)) { process.stdout.write('[]'); process.exit(0); }",
                'const entries = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({',
                'name: entry.name,',
                "path: [dir.replace(/\\/+$/, ''), entry.name].join('/').replace(/\\\\/g, '/'),",
                'isDirectory: entry.isDirectory(),',
                '}));',
                'process.stdout.write(JSON.stringify(entries));',
              ].join(' ')
            )}`,
          ];

    const output = await this.execSsh(profile, command, runtime.resolvedHost);
    const trimmed = output.trim();
    if (!trimmed) {
      return [];
    }
    const parsed = JSON.parse(trimmed) as RemoteDirectoryEntry | RemoteDirectoryEntry[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      ...entry,
      path: normalizeRemotePath(entry.path),
    }));
  }

  private async remoteFileExists(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    targetPath: string
  ): Promise<boolean> {
    const command =
      runtime.platform === 'win32'
        ? [
            'powershell',
            '-NoProfile',
            '-Command',
            `if (Test-Path -LiteralPath ${this.toPowerShellString(targetPath)} -PathType Leaf) { Write-Output true } else { Write-Output false }`,
          ]
        : [
            `node -e ${shellQuote(
              [
                "const fs = require('node:fs');",
                `const target = ${JSON.stringify(targetPath)};`,
                "try { process.stdout.write(String(fs.statSync(target).isFile())); } catch { process.stdout.write('false'); }",
              ].join(' ')
            )}`,
          ];
    const output = await this.execSsh(profile, command, runtime.resolvedHost);
    return output.trim() === 'true';
  }

  private async deleteRemotePath(
    profile: ConnectionProfile,
    runtime: ConnectionRuntime,
    targetPath: string
  ): Promise<void> {
    const command =
      runtime.platform === 'win32'
        ? [
            'powershell',
            '-NoProfile',
            '-Command',
            `if (Test-Path -LiteralPath ${this.toPowerShellString(targetPath)}) { Remove-Item -LiteralPath ${this.toPowerShellString(targetPath)} -Recurse -Force }`,
          ]
        : [`rm -rf ${shellQuote(targetPath)}`];
    await this.execSsh(profile, command, runtime.resolvedHost);
  }

  private toPowerShellString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private async resolveRuntime(
    profile: ConnectionProfile,
    refresh: boolean
  ): Promise<ConnectionRuntime> {
    const cached = this.runtimes.get(profile.id);
    if (cached && !refresh) {
      return cached;
    }

    const resolvedHost = await this.ensureHostTrusted(profile);
    const envInfoRaw = await this.execSsh(
      profile,
      [
        'node -e "const os=require(\'os\'); console.log(JSON.stringify({platform:process.platform,homeDir:os.homedir(),nodeVersion:process.version}))"',
      ],
      resolvedHost
    );
    const envInfo = JSON.parse(envInfoRaw.trim()) as {
      platform: RemotePlatform;
      homeDir: string;
      nodeVersion: string;
    };
    const gitVersion = await this.execSsh(profile, ['git --version'], resolvedHost);

    const runtime: ConnectionRuntime = {
      platform: envInfo.platform,
      homeDir: envInfo.homeDir,
      nodeVersion: envInfo.nodeVersion,
      gitVersion: gitVersion.trim(),
      resolvedHost,
    };
    this.runtimes.set(profile.id, runtime);
    return runtime;
  }

  private async ensureHostTrusted(profile: ConnectionProfile): Promise<ResolvedHostConfig> {
    const config = await this.resolveHostConfig(profile);
    const allKnownHostsFiles = uniquePaths([
      ...config.userKnownHostsFiles,
      ...config.globalKnownHostsFiles,
    ]);
    const known = await this.isKnownHost(config.knownHost, config.port, allKnownHostsFiles);
    if (known) {
      return config;
    }

    const appKnownHostsPath = getAppKnownHostsPath();
    await mkdir(getRemoteStateRoot(), { recursive: true });
    const scannedKeys = await this.scanHostKeys(config);
    const fingerprints = await this.buildFingerprints(scannedKeys, config.knownHost, config.port);
    await this.authBroker.requestHostVerification(profile, {
      host: config.knownHost,
      port: config.port,
      fingerprints,
    });
    await appendFile(
      appKnownHostsPath,
      scannedKeys.endsWith('\n') ? scannedKeys : `${scannedKeys}\n`,
      'utf8'
    );

    return {
      ...config,
      userKnownHostsFiles: uniquePaths([appKnownHostsPath, ...config.userKnownHostsFiles]),
    };
  }

  private async resolveHostConfig(profile: ConnectionProfile): Promise<ResolvedHostConfig> {
    const result = await runLocalCommand('ssh', ['-G', profile.sshTarget]);
    if (result.code !== 0) {
      throw createRemoteError('Failed to resolve SSH configuration', undefined, result.stderr);
    }

    const config = parseSshConfig(result.stdout);
    const host = config.get('hostname')?.[0];
    const port = Number.parseInt(config.get('port')?.[0] ?? '22', 10) || 22;
    const appKnownHostsPath = getAppKnownHostsPath();
    const userKnownHostsFiles = uniquePaths([
      appKnownHostsPath,
      ...(config.get('userknownhostsfile') ?? []),
    ]);
    const globalKnownHostsFiles = uniquePaths(config.get('globalknownhostsfile') ?? []);

    if (!host) {
      throw createRemoteError('Failed to resolve SSH target for {{connectionId}}', {
        connectionId: profile.id,
      });
    }
    const knownHost = config.get('hostkeyalias')?.[0] || host;

    return {
      host,
      port,
      knownHost,
      userKnownHostsFiles,
      globalKnownHostsFiles,
    };
  }

  private async isKnownHost(host: string, port: number, files: string[]): Promise<boolean> {
    const queries = getKnownHostQueries(host, port);
    for (const file of files) {
      if (!(await pathExists(file))) {
        continue;
      }
      for (const query of queries) {
        const result = await runLocalCommand('ssh-keygen', ['-F', query, '-f', file]);
        if (result.code === 0) {
          return true;
        }
      }
    }
    return false;
  }

  private async buildFingerprints(
    scannedKeys: string,
    host: string,
    port: number
  ): Promise<RemoteHostFingerprint[]> {
    const tempPath = join(
      app.getPath('temp'),
      `enso-remote-host-${host.replace(/[^a-z0-9_.-]/gi, '_')}-${port}-${randomUUID()}.keys`
    );
    try {
      await writeFile(tempPath, scannedKeys, 'utf8');
      const result = await runLocalCommand('ssh-keygen', ['-lf', tempPath]);
      if (result.code !== 0) {
        throw createRemoteError(
          'Failed to parse remote host fingerprint',
          undefined,
          result.stderr
        );
      }
      const fingerprints = result.stdout
        .split(/\r?\n/)
        .map((line) => parseFingerprintLine(line, host, port))
        .filter((item): item is RemoteHostFingerprint => item !== null);
      if (fingerprints.length === 0) {
        throw createRemoteError('Failed to parse remote host fingerprint');
      }
      return fingerprints;
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  private async scanHostKeys(config: ResolvedHostConfig): Promise<string> {
    const result = await runLocalCommand(
      'ssh-keyscan',
      ['-T', String(SSH_KEYSCAN_TIMEOUT_SECONDS), '-p', String(config.port), config.host],
      {
        LANG: 'C',
        LC_ALL: 'C',
      }
    );
    const scannedKeys = normalizeScannedKnownHostsEntries(
      result.stdout,
      config.knownHost,
      config.port
    );
    if (scannedKeys) {
      return scannedKeys;
    }

    throw createRemoteError('Failed to scan remote host fingerprint', undefined, result.stderr);
  }

  private async buildSshContext(
    profile: ConnectionProfile,
    resolvedHost: ResolvedHostConfig
  ): Promise<SshContext> {
    await mkdir(getRemoteStateRoot(), { recursive: true });
    const askpassEnv = await this.authBroker.getAskpassEnv(profile);
    const env = {
      ...getEnvForCommand(),
      ...askpassEnv,
      LANG: 'C',
      LC_ALL: 'C',
    };
    const optionArgs = [
      '-o',
      'BatchMode=no',
      '-o',
      'PreferredAuthentications=publickey,keyboard-interactive,password',
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${resolvedHost.userKnownHostsFiles.join(' ')}`,
    ];
    return { env, optionArgs };
  }

  private async resolveProfile(
    profileOrId: string | ConnectionProfile
  ): Promise<ConnectionProfile> {
    await this.loadProfiles();
    if (typeof profileOrId !== 'string') {
      return profileOrId;
    }
    const profile = this.profiles.get(profileOrId);
    if (!profile) {
      throw createRemoteError('Unknown remote profile: {{connectionId}}', {
        connectionId: profileOrId,
      });
    }
    return profile;
  }

  private async flush(): Promise<void> {
    const path = getRemoteSettingsPath();
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(path, JSON.stringify(this.listProfiles(), null, 2), 'utf8');
  }

  private async execSsh(
    profile: ConnectionProfile,
    remoteCommand: string[],
    resolvedHost: ResolvedHostConfig
  ): Promise<string> {
    const { spawn } = await import('node:child_process');
    const sshContext = await this.buildSshContext(profile, resolvedHost);

    return new Promise((resolve, reject) => {
      const args = [...sshContext.optionArgs, profile.sshTarget, ...remoteCommand];
      const child = spawn('ssh', args, {
        env: sshContext.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        const detail =
          stderr.trim() ||
          stdout.trim() ||
          translateRemote('SSH command exited with code {{code}}', {
            code: String(code ?? 'unknown'),
          });
        if (isAuthenticationFailure(detail)) {
          this.authBroker.clearSecrets(profile.id);
          this.runtimes.delete(profile.id);
        }
        reject(new Error(detail));
      });
    });
  }
}

export const remoteConnectionManager = new RemoteConnectionManager();
