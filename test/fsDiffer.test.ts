import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDirectory, detectChanges } from '../src/fsDiffer';

let original: string;
let scratch: string;

beforeEach(() => {
  original = mkdtempSync(join(tmpdir(), 'bashle-orig-'));
  writeFileSync(join(original, 'keep.txt'), 'unchanged\n');
  writeFileSync(join(original, 'edit.txt'), 'one\ntwo\n');
  mkdirSync(join(original, 'nested'));
  writeFileSync(join(original, 'nested', 'deep.txt'), 'deep\n');
  scratch = mkdtempSync(join(tmpdir(), 'bashle-scratch-'));
  cpSync(original, scratch, { recursive: true });
});

afterEach(() => {
  rmSync(original, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const changesAfter = async (mutate: () => void) => {
  const before = await snapshotDirectory(scratch);
  mutate();
  return detectChanges({ scratchRoot: scratch, originalRoot: original, before });
};

describe('detectChanges', () => {
  it('reports nothing when the script touched nothing', async () => {
    expect(await changesAfter(() => {})).toEqual([]);
  });

  it('reports a created file', async () => {
    const changes = await changesAfter(() => writeFileSync(join(scratch, 'new.txt'), 'hi\n'));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('created');
    expect(changes[0]!.path).toBe('new.txt');
  });

  it('reports a deleted file', async () => {
    const changes = await changesAfter(() => unlinkSync(join(scratch, 'keep.txt')));
    expect(changes.map((c) => [c.kind, c.path])).toEqual([['deleted', 'keep.txt']]);
  });

  it('reports a modified file with a diff of what changed', async () => {
    const changes = await changesAfter(() => writeFileSync(join(scratch, 'edit.txt'), 'one\nTWO\n'));
    expect(changes[0]!.kind).toBe('modified');
    expect(changes[0]!.diff).toContain('-two');
    expect(changes[0]!.diff).toContain('+TWO');
  });

  it('finds changes in nested directories', async () => {
    const changes = await changesAfter(() =>
      writeFileSync(join(scratch, 'nested', 'deep.txt'), 'changed\n'),
    );
    expect(changes[0]!.path).toBe('nested/deep.txt');
  });

  it('marks binary files instead of diffing them', async () => {
    const changes = await changesAfter(() =>
      writeFileSync(join(scratch, 'edit.txt'), Buffer.from([0x00, 0x01, 0x02, 0x00])),
    );
    expect(changes[0]!.binary).toBe(true);
    expect(changes[0]!.diff).toBeUndefined();
  });

  it('sorts changes by path so the panel is stable between runs', async () => {
    const changes = await changesAfter(() => {
      writeFileSync(join(scratch, 'zzz.txt'), 'z');
      writeFileSync(join(scratch, 'aaa.txt'), 'a');
    });
    expect(changes.map((c) => c.path)).toEqual(['aaa.txt', 'zzz.txt']);
  });

  it('ignores paths the runner writes for its own bookkeeping', async () => {
    const changes = await changesAfter(() => {
      mkdirSync(join(scratch, '.bashle'));
      writeFileSync(join(scratch, '.bashle', 'driver.sh'), 'x');
    });
    expect(changes).toEqual([]);
  });
});
