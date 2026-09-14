import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FileChange } from './types';

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export type DirectorySnapshot = Map<string, FileStamp>;

export const BOOKKEEPING_DIRECTORIES = new Set(['.bashle', '.git', 'node_modules']);

const MAX_DIFFABLE_BYTES = 512 * 1024;
const MAX_DIFFABLE_LINES = 4000;
const BINARY_SNIFF_BYTES = 8000;

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

async function walk(root: string, current: string, into: DirectorySnapshot): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (BOOKKEEPING_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, into);
    } else if (entry.isFile()) {
      const stats = await stat(absolute);
      into.set(toPosixPath(relative(root, absolute)), {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
  }
}

export async function snapshotDirectory(root: string): Promise<DirectorySnapshot> {
  const snapshot: DirectorySnapshot = new Map();
  await walk(root, root, snapshot);
  return snapshot;
}

function looksBinary(contents: Buffer): boolean {
  return contents.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function longestCommonSubsequenceTable(before: string[], after: string[]): number[][] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

export function diffLines(beforeText: string, afterText: string): string {
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  if (before.length > MAX_DIFFABLE_LINES || after.length > MAX_DIFFABLE_LINES) {
    return `@@ ${before.length} lines -> ${after.length} lines (too large to diff) @@`;
  }

  const table = longestCommonSubsequenceTable(before, after);
  const lines: string[] = [];
  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push(` ${before[i]}`);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push(`-${before[i]}`);
      i++;
    } else {
      lines.push(`+${after[j]}`);
      j++;
    }
  }
  while (i < before.length) lines.push(`-${before[i++]}`);
  while (j < after.length) lines.push(`+${after[j++]}`);

  return lines.join('\n');
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function describeModification(
  relativePath: string,
  originalRoot: string,
  scratchRoot: string,
  stamp: FileStamp,
  previous: FileStamp,
): Promise<FileChange | null> {
  const originalContents = await readIfPresent(join(originalRoot, relativePath));
  const scratchContents = await readIfPresent(join(scratchRoot, relativePath));
  if (!scratchContents) return null;

  if (originalContents && originalContents.equals(scratchContents)) return null;

  const change: FileChange = {
    kind: 'modified',
    path: relativePath,
    sizeBefore: previous.size,
    sizeAfter: stamp.size,
  };

  const isBinary =
    looksBinary(scratchContents) || (originalContents !== null && looksBinary(originalContents));
  if (isBinary) return { ...change, binary: true };
  if (scratchContents.length > MAX_DIFFABLE_BYTES) return change;

  return {
    ...change,
    diff: diffLines(originalContents?.toString('utf8') ?? '', scratchContents.toString('utf8')),
  };
}

async function describeCreation(
  relativePath: string,
  scratchRoot: string,
  stamp: FileStamp,
): Promise<FileChange> {
  const contents = await readIfPresent(join(scratchRoot, relativePath));
  const change: FileChange = { kind: 'created', path: relativePath, sizeAfter: stamp.size };
  if (!contents) return change;
  if (looksBinary(contents)) return { ...change, binary: true };
  if (contents.length > MAX_DIFFABLE_BYTES) return change;
  return { ...change, diff: diffLines('', contents.toString('utf8')) };
}

export interface DetectChangesOptions {
  scratchRoot: string;
  originalRoot: string;
  before: DirectorySnapshot;
}

export async function detectChanges({
  scratchRoot,
  originalRoot,
  before,
}: DetectChangesOptions): Promise<FileChange[]> {
  const after = await snapshotDirectory(scratchRoot);
  const changes: FileChange[] = [];

  for (const [relativePath, stamp] of after) {
    const previous = before.get(relativePath);
    if (!previous) {
      changes.push(await describeCreation(relativePath, scratchRoot, stamp));
      continue;
    }
    const looksUntouched = previous.size === stamp.size && previous.mtimeMs === stamp.mtimeMs;
    if (looksUntouched) continue;

    const modification = await describeModification(
      relativePath,
      originalRoot,
      scratchRoot,
      stamp,
      previous,
    );
    if (modification) changes.push(modification);
  }

  for (const [relativePath, previous] of before) {
    if (!after.has(relativePath)) {
      changes.push({ kind: 'deleted', path: relativePath, sizeBefore: previous.size });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
