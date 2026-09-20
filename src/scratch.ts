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

/** Copies one file, symlink or whole directory; `destination` must not exist. */
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

/**
 * What one directory costs to clone, and whether anything under it is ignored.
 * A `clean` subtree can be handed to a single `cp`, which is what keeps this
 * down to a few processes on a normal workspace; only the directories that
 * actually contain an ignored path get walked entry by entry.
 */
interface PlannedDirectory {
  clean: boolean;
  bytes: number;
  children: Array<{ name: string; node: PlannedDirectory }>;
}

async function planDirectory(
  absolute: string,
  relative: string,
  rules: IgnoreRules,
): Promise<PlannedDirectory> {
  const children: PlannedDirectory['children'] = [];
  let clean = true;
  let bytes = 0;

  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (rules.ignores(childRelative)) {
      clean = false;
      continue;
    }

    const childAbsolute = join(absolute, entry.name);
    // A symlink is a leaf even when it points at a directory: cp -R copies the
    // link itself, and following it could walk outside the workspace.
    const node = entry.isDirectory()
      ? await planDirectory(childAbsolute, childRelative, rules)
      : { clean: true, bytes: (await lstat(childAbsolute)).size, children: [] };

    if (!node.clean) clean = false;
    bytes += node.bytes;
    children.push({ name: entry.name, node });
  }

  return { clean, bytes, children };
}

async function copyPlanned(
  absolute: string,
  destination: string,
  node: PlannedDirectory,
  platform: NodeJS.Platform,
): Promise<void> {
  if (node.clean) {
    await cloneEntry(absolute, destination, platform);
    return;
  }
  await mkdir(destination, { recursive: true });
  for (const child of node.children) {
    await copyPlanned(join(absolute, child.name), join(destination, child.name), child.node, platform);
  }
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
  // The scratch root already exists, so its children are copied in one by one
  // rather than handing the whole workspace to a single cp.
  for (const child of plan.children) {
    await copyPlanned(join(sourceRoot, child.name), join(root, child.name), child.node, process.platform);
  }

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
