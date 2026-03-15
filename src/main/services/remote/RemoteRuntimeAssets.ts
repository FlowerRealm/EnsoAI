import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemotePlatform } from '@shared/types';
import { app } from 'electron';

export type RemoteRuntimeArch = 'x64' | 'arm64';
export type RemoteRuntimeArchiveKind = 'tar.gz' | 'zip';

export interface RemoteRuntimeAsset {
  platform: RemotePlatform;
  arch: RemoteRuntimeArch;
  archiveName: string;
  checksum: string;
  kind: RemoteRuntimeArchiveKind;
  nodeVersion: string;
  url: string;
}

export const MANAGED_REMOTE_NODE_VERSION = '20.19.0';
export const MANAGED_REMOTE_RUNTIME_DIR = '.ensoai/remote-runtime';

const REMOTE_RUNTIME_ARCHIVES: Record<string, Omit<RemoteRuntimeAsset, 'url'>> = {
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    archiveName: 'node-v20.19.0-darwin-arm64.tar.gz',
    checksum: 'c016cd1975a264a29dc1b07c6fbe60d5df0a0c2beb4113c0450e3d998d1a0d9c',
    kind: 'tar.gz',
    nodeVersion: MANAGED_REMOTE_NODE_VERSION,
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    archiveName: 'node-v20.19.0-darwin-x64.tar.gz',
    checksum: 'a8554af97d6491fdbdabe63d3a1cfb9571228d25a3ad9aed2df856facb131b20',
    kind: 'tar.gz',
    nodeVersion: MANAGED_REMOTE_NODE_VERSION,
  },
  'linux-arm64': {
    platform: 'linux',
    arch: 'arm64',
    archiveName: 'node-v20.19.0-linux-arm64.tar.gz',
    checksum: '618e4294602b78e97118a39050116b70d088b16197cd3819bba1fc18b473dfc4',
    kind: 'tar.gz',
    nodeVersion: MANAGED_REMOTE_NODE_VERSION,
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    archiveName: 'node-v20.19.0-linux-x64.tar.gz',
    checksum: '8a4dbcdd8bccef3132d21e8543940557e55dcf44f00f0a99ba8a062f4552e722',
    kind: 'tar.gz',
    nodeVersion: MANAGED_REMOTE_NODE_VERSION,
  },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    archiveName: 'node-v20.19.0-win-arm64.zip',
    checksum: '773325a26ad51a5ba857963825dee3a871eacef653c31d62e5492574c965accb',
    kind: 'zip',
    nodeVersion: MANAGED_REMOTE_NODE_VERSION,
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    archiveName: 'node-v20.19.0-win-x64.zip',
    checksum: 'be72284c7bc62de07d5a9fd0ae196879842c085f11f7f2b60bf8864c0c9d6a4f',
    kind: 'zip',
    nodeVersion: MANAGED_REMOTE_NODE_VERSION,
  },
};

function getRuntimeCacheRoot(): string {
  return join(app.getPath('userData'), 'remote-runtime-cache');
}

function buildNodeDownloadUrl(archiveName: string): string {
  return `https://nodejs.org/dist/v${MANAGED_REMOTE_NODE_VERSION}/${archiveName}`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function fileHasExpectedChecksum(filePath: string, checksum: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  return (await sha256File(filePath)) === checksum;
}

function resolveBundledRuntimeAssetPath(archiveName: string): string | null {
  const candidates = [
    join(process.resourcesPath, 'remote-runtime', archiveName),
    join(app.getAppPath(), 'resources', 'remote-runtime', archiveName),
    join(process.cwd(), 'resources', 'remote-runtime', archiveName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function writeResponseBodyToFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'EnsoAI Remote Runtime Installer',
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download remote runtime archive: ${response.status} ${response.statusText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

export function getRemoteRuntimeAsset(
  platform: RemotePlatform,
  arch: RemoteRuntimeArch
): RemoteRuntimeAsset {
  const key = `${platform}-${arch}`;
  const asset = REMOTE_RUNTIME_ARCHIVES[key];
  if (!asset) {
    throw new Error(`Unsupported remote runtime target: ${key}`);
  }

  return {
    ...asset,
    url: buildNodeDownloadUrl(asset.archiveName),
  };
}

export async function ensureRemoteRuntimeAsset(
  platform: RemotePlatform,
  arch: RemoteRuntimeArch
): Promise<{
  asset: RemoteRuntimeAsset;
  localPath: string;
  source: 'bundle' | 'cache' | 'download';
}> {
  const asset = getRemoteRuntimeAsset(platform, arch);
  const bundledPath = resolveBundledRuntimeAssetPath(asset.archiveName);
  if (bundledPath && (await fileHasExpectedChecksum(bundledPath, asset.checksum))) {
    return {
      asset,
      localPath: bundledPath,
      source: 'bundle',
    };
  }

  const cacheRoot = getRuntimeCacheRoot();
  await mkdir(cacheRoot, { recursive: true });
  const cachedPath = join(cacheRoot, asset.archiveName);

  if (await fileHasExpectedChecksum(cachedPath, asset.checksum)) {
    return {
      asset,
      localPath: cachedPath,
      source: 'cache',
    };
  }

  const tempPath = `${cachedPath}.download`;
  await rm(tempPath, { force: true }).catch(() => {});
  await writeResponseBodyToFile(asset.url, tempPath);

  if (!(await fileHasExpectedChecksum(tempPath, asset.checksum))) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new Error(
      `Downloaded remote runtime archive failed checksum verification: ${asset.archiveName}`
    );
  }

  await rename(tempPath, cachedPath);
  return {
    asset,
    localPath: cachedPath,
    source: 'download',
  };
}
