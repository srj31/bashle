import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, lstat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadIgnoreRules, type IgnoreRules } from './ignoreRules';

const run = promisify(execFile);

export const BOOKKEEPING_DIRECTORY_NAME = '.bashle';

export class WorkspaceTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(
      `This workspace is ${(bytes / 1e6).toFixed(0)} MB, above the ${(limit / 1e6).toFixed(0)} MB clone limit. ` +
        `Raise "bashle.maxCloneBytes", or ignore what the run does not need in .bashleignore.`,
    );
    this.name = 'WorkspaceTooLargeError';
  }
}

export interface ScratchWorkspace {
  root: string;
  bookkeepingDirectory: string;
  home: string;
  temp: string;
  dispose(): Promise<void>;
}

/**
 * Copy-on-write flags, so cloning a workspace is instant and costs no disk
 * until the run writes: `-c` is APFS clonefile, `--reflink=auto` is the GNU
 * equivalent on btrfs and xfs. Both degrade to a plain recursive copy.
 */
const CLONE_FLAGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '-c',
  linux: '--reflink=auto',
};

async function cloneEntry(
  source: string,
  destination: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const cowFlag = CLONE_FLAGS[platform];
  if (cowFlag) {
    try {
      await run('cp', [cowFlag, '-R', source, destination]);
      return;
    } catch {
      // A cp without the flag, or a filesystem that cannot clone: copy properly.
    }
  }
  await run('cp', ['-R', source, destination]);
}

interface DirectoryPlan {
  nothingIgnoredBelow: boolean;
  bytes: number;
  children: Array<{ name: string; plan: DirectoryPlan }>;
}

const leafPlan = (bytes: number): DirectoryPlan => ({
  nothingIgnoredBelow: true,
  bytes,
  children: [],
});

async function planDirectory(
  absolute: string,
  relative: string,
  rules: IgnoreRules,
): Promise<DirectoryPlan> {
  const children: DirectoryPlan['children'] = [];
  let nothingIgnoredBelow = true;
  let bytes = 0;

  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (rules.ignores(childRelative)) {
      nothingIgnoredBelow = false;
      continue;
    }

    const childAbsolute = join(absolute, entry.name);
    const plan = entry.isDirectory()
      ? await planDirectory(childAbsolute, childRelative, rules)
      : leafPlan((await lstat(childAbsolute)).size);

    if (!plan.nothingIgnoredBelow) nothingIgnoredBelow = false;
    bytes += plan.bytes;
    children.push({ name: entry.name, plan });
  }

  return { nothingIgnoredBelow, bytes, children };
}

async function copyPlannedChildren(
  sourceDirectory: string,
  destinationDirectory: string,
  plan: DirectoryPlan,
  platform: NodeJS.Platform,
): Promise<void> {
  for (const child of plan.children) {
    await copyPlanned(
      join(sourceDirectory, child.name),
      join(destinationDirectory, child.name),
      child.plan,
      platform,
    );
  }
}

async function copyPlanned(
  absolute: string,
  destination: string,
  plan: DirectoryPlan,
  platform: NodeJS.Platform,
): Promise<void> {
  if (plan.nothingIgnoredBelow) {
    await cloneEntry(absolute, destination, platform);
    return;
  }
  await mkdir(destination, { recursive: true });
  await copyPlannedChildren(absolute, destination, plan, platform);
}

export interface CreateScratchOptions {
  sourceRoot: string;
  maxBytes: number;
}

export async function createScratchClone({
  sourceRoot,
  maxBytes,
}: CreateScratchOptions): Promise<ScratchWorkspace> {
  const rules = await loadIgnoreRules(sourceRoot);
  const plan = await planDirectory(sourceRoot, '', rules);
  if (plan.bytes > maxBytes) throw new WorkspaceTooLargeError(plan.bytes, maxBytes);

  const created = await mkdtemp(join(tmpdir(), 'bashle-run-'));
  const root = await realpath(created);
  await copyPlannedChildren(sourceRoot, root, plan, process.platform);

  const bookkeepingDirectory = join(root, BOOKKEEPING_DIRECTORY_NAME);
  const home = join(bookkeepingDirectory, 'home');
  const temp = join(bookkeepingDirectory, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(temp, { recursive: true });

  return {
    root,
    bookkeepingDirectory,
    home,
    temp,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
