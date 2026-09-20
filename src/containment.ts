import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BUBBLEWRAP_SEARCH_PATH,
  LINUX_FORBIDDEN_EXECUTABLES,
  SANDBOX_EXEC,
  buildBubblewrapArgs,
  buildSandboxProfile,
} from './sandbox';

const run = promisify(execFile);

export type ContainmentKind = 'seatbelt' | 'bubblewrap' | 'none';

export interface ContainmentTool {
  kind: 'seatbelt' | 'bubblewrap';
  path: string;
  /** Set when the kernel refused a network namespace and the run is not isolated from the network. */
  allowNetwork?: boolean;
}

export type ContainmentUnavailable =
  | { reason: 'disabled' }
  | { reason: 'unsupported-platform'; platform: NodeJS.Platform }
  | { reason: 'not-installed' }
  | { reason: 'not-usable'; path: string }
  | { reason: 'seatbelt-missing' };

export interface ContainmentPlan {
  kind: ContainmentKind;
  /** Argv to put in front of the bash invocation. Empty when nothing wraps it. */
  prefix: string[];
  /** Written to disk before the run; seatbelt is configured by file, bwrap by argv. */
  profile?: { path: string; contents: string };
  warning?: string;
}

const PROFILE_FILE_NAME = 'profile.sb';

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const found = await Promise.all(paths.map(async (path) => ((await isExecutable(path)) ? path : null)));
  return found.filter((path): path is string => path !== null);
}

async function bubblewrapAccepts(path: string, allowNetwork: boolean): Promise<boolean> {
  const probeArgs = buildBubblewrapArgs({
    writableRoots: [],
    workingDirectory: '/',
    allowNetwork,
  });
  try {
    await run(path, [...probeArgs, '/bin/sh', '-c', 'exit 0'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bubblewrap needs unprivileged user namespaces, which several distributions
 * ship disabled, so finding the binary is not enough — it has to build a real
 * sandbox before we promise the user one. Some kernels, container runtimes
 * included, then refuse only the network namespace; that still leaves a
 * working file sandbox, so it is reported rather than thrown away.
 */
async function probeBubblewrap(path: string): Promise<'isolated' | 'no-network-namespace' | 'broken'> {
  if (await bubblewrapAccepts(path, false)) return 'isolated';
  if (await bubblewrapAccepts(path, true)) return 'no-network-namespace';
  return 'broken';
}

async function findBubblewrap(): Promise<ContainmentTool | ContainmentUnavailable> {
  const onDisk = await existingPaths(BUBBLEWRAP_SEARCH_PATH.filter((path) => path.startsWith('/')));
  // A bare `bwrap` off PATH is the last resort: `access` cannot check a name.
  const candidates = [...onDisk, 'bwrap'];

  for (const candidate of candidates) {
    const capability = await probeBubblewrap(candidate);
    if (capability === 'broken') continue;
    return {
      kind: 'bubblewrap',
      path: candidate,
      ...(capability === 'no-network-namespace' ? { allowNetwork: true } : {}),
    };
  }
  const installedAt = onDisk[0];
  return installedAt ? { reason: 'not-usable', path: installedAt } : { reason: 'not-installed' };
}

export async function discoverContainment(
  platform: NodeJS.Platform = process.platform,
): Promise<ContainmentTool | ContainmentUnavailable> {
  if (platform === 'darwin') {
    return (await isExecutable(SANDBOX_EXEC))
      ? { kind: 'seatbelt', path: SANDBOX_EXEC }
      : { reason: 'seatbelt-missing' };
  }
  if (platform === 'linux') return findBubblewrap();
  return { reason: 'unsupported-platform', platform };
}

let cachedDiscovery: Promise<ContainmentTool | ContainmentUnavailable> | null = null;

/**
 * Discovery spawns a sandbox to test it, so a hit is remembered — a sandbox
 * does not stop existing. A miss is not: someone who reads the warning and
 * installs bubblewrap should get containment on their next save, not after a
 * window reload.
 */
function discoverOnce(platform: NodeJS.Platform): Promise<ContainmentTool | ContainmentUnavailable> {
  if (platform !== process.platform) return discoverContainment(platform);
  cachedDiscovery ??= discoverContainment(platform).then((found) => {
    if ('reason' in found) cachedDiscovery = null;
    return found;
  });
  return cachedDiscovery;
}

export function describeUnavailable(unavailable: ContainmentUnavailable): string {
  const onlyTheClone = 'only the scratch clone is containing this run.';
  switch (unavailable.reason) {
    case 'disabled':
      return `Sandbox enforcement is off; ${onlyTheClone}`;
    case 'unsupported-platform':
      return (
        `Kernel-enforced containment is available on macOS (sandbox-exec) and Linux (bubblewrap), ` +
        `not on ${unavailable.platform}; ${onlyTheClone}`
      );
    case 'not-usable':
      return (
        `${unavailable.path} could not create a sandbox — unprivileged user namespaces are often ` +
        `disabled; ${onlyTheClone}`
      );
    case 'not-installed':
      return (
        `bubblewrap (bwrap) was not found; ${onlyTheClone} ` +
        `Install it with \`apt install bubblewrap\`, \`dnf install bubblewrap\` or the equivalent.`
      );
    case 'seatbelt-missing':
      return `${SANDBOX_EXEC} is not on this machine; ${onlyTheClone}`;
  }
}

export interface PlanContainmentOptions {
  enforce: boolean;
  scratchRoot: string;
  bookkeepingDirectory: string;
  platform?: NodeJS.Platform;
}

export async function planContainment({
  enforce,
  scratchRoot,
  bookkeepingDirectory,
  platform = process.platform,
}: PlanContainmentOptions): Promise<ContainmentPlan> {
  if (!enforce) {
    return { kind: 'none', prefix: [], warning: describeUnavailable({ reason: 'disabled' }) };
  }

  const tool = await discoverOnce(platform);
  if ('reason' in tool) return { kind: 'none', prefix: [], warning: describeUnavailable(tool) };

  if (tool.kind === 'seatbelt') {
    const profilePath = join(bookkeepingDirectory, PROFILE_FILE_NAME);
    return {
      kind: 'seatbelt',
      prefix: [tool.path, '-f', profilePath],
      profile: { path: profilePath, contents: buildSandboxProfile({ writableRoots: [scratchRoot] }) },
    };
  }

  return {
    kind: 'bubblewrap',
    prefix: [
      tool.path,
      ...buildBubblewrapArgs({
        writableRoots: [scratchRoot],
        workingDirectory: scratchRoot,
        allowNetwork: tool.allowNetwork,
        blockedExecutables: await existingPaths(LINUX_FORBIDDEN_EXECUTABLES),
      }),
    ],
    ...(tool.allowNetwork
      ? {
          warning:
            'This kernel refused a network namespace, so the run is contained on disk but can ' +
            'still reach the network.',
        }
      : {}),
  };
}
