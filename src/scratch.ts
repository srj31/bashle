import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const BOOKKEEPING_DIRECTORY_NAME = '.bashle';

export class WorkspaceTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(
      `This workspace is ${(bytes / 1e6).toFixed(0)} MB, above the ${(limit / 1e6).toFixed(0)} MB clone limit. ` +
        `Raise "bashle.maxCloneBytes" or run Bashle from a smaller folder.`,
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

export async function measureDirectoryBytes(root: string): Promise<number> {
  const { stdout } = await run('du', ['-sk', root], { maxBuffer: 1 << 20 });
  return Number(stdout.trim().split(/\s+/)[0] ?? 0) * 1024;
}

async function cloneTree(sourceRoot: string, destination: string): Promise<void> {
  try {
    await run('cp', ['-c', '-R', `${sourceRoot}/.`, destination]);
  } catch {
    await run('cp', ['-R', `${sourceRoot}/.`, destination]);
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
  const bytes = await measureDirectoryBytes(sourceRoot);
  if (bytes > maxBytes) throw new WorkspaceTooLargeError(bytes, maxBytes);

  const created = await mkdtemp(join(tmpdir(), 'bashle-run-'));
  const root = await realpath(created);
  await cloneTree(sourceRoot, root);

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
