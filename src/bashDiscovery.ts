import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const MINIMUM_BASH = { major: 4, minor: 1 } as const;

/**
 * Searched in order; the first candidate that is new enough wins. macOS keeps
 * bash 3.2 at /bin/bash, so Homebrew comes first there and the system copy is
 * only ever reached to be rejected with a useful message.
 */
const SEARCH_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', 'bash', '/bin/bash'],
  linux: ['/usr/bin/bash', '/bin/bash', '/usr/local/bin/bash', 'bash'],
};

const FALLBACK_SEARCH_PATH = ['bash', '/usr/bin/bash', '/bin/bash'];

/** A bare name is resolved through PATH by execFile, which covers Nix and asdf. */
export function bashSearchPath(platform: NodeJS.Platform = process.platform): string[] {
  return SEARCH_PATHS[platform] ?? FALLBACK_SEARCH_PATH;
}

const INSTALL_HINTS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Install a newer bash with `brew install bash`',
  linux: 'Install a newer bash with your package manager (`apt install bash`, `dnf install bash`)',
};

export interface BashVersion {
  version: string;
  major: number;
  minor: number;
}

export interface DiscoveredBash extends BashVersion {
  path: string;
}

const VERSION_BANNER = /GNU bash, version (\d+)\.(\d+)\.(\d+)/;

export function parseBashVersion(banner: string): BashVersion | null {
  const matched = VERSION_BANNER.exec(banner);
  if (!matched) return null;
  return {
    version: `${matched[1]}.${matched[2]}.${matched[3]}`,
    major: Number(matched[1]),
    minor: Number(matched[2]),
  };
}

export function meetsMinimumVersion({ major, minor }: BashVersion): boolean {
  if (major > MINIMUM_BASH.major) return true;
  return major === MINIMUM_BASH.major && minor >= MINIMUM_BASH.minor;
}

export class UnsupportedBashError extends Error {
  constructor(readonly rejected: DiscoveredBash[], platform: NodeJS.Platform = process.platform) {
    const found = rejected.length
      ? rejected.map((b) => `  ${b.path} is ${b.version}`).join('\n')
      : '  no bash executable was found';
    const hint = INSTALL_HINTS[platform] ?? 'Install a newer bash';
    super(
      `Bashle needs bash ${MINIMUM_BASH.major}.${MINIMUM_BASH.minor} or newer for BASH_XTRACEFD.\n${found}\n` +
        `${hint}, or set "bashle.bashPath" to one you already have.`,
    );
    this.name = 'UnsupportedBashError';
  }
}

async function inspect(path: string): Promise<DiscoveredBash | null> {
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 3000 });
    const version = parseBashVersion(stdout);
    return version ? { path, ...version } : null;
  } catch {
    return null;
  }
}

export async function discoverBash(
  configuredPath = '',
  searchPath: string[] = bashSearchPath(),
): Promise<DiscoveredBash> {
  const candidates = configuredPath ? [configuredPath] : searchPath;
  const rejected: DiscoveredBash[] = [];

  for (const candidate of candidates) {
    const found = await inspect(candidate);
    if (!found) continue;
    if (meetsMinimumVersion(found)) return found;
    if (!rejected.some((earlier) => earlier.version === found.version)) rejected.push(found);
  }
  throw new UnsupportedBashError(rejected);
}
