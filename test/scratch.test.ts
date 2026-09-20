import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScratchClone, WorkspaceTooLargeError, type ScratchWorkspace } from '../src/scratch';

let source: string;
const open: ScratchWorkspace[] = [];

const write = (relativePath: string, contents = 'x\n') => {
  const full = join(source, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
};

const clone = async (maxBytes = 1e9) => {
  const scratch = await createScratchClone({ sourceRoot: source, maxBytes });
  open.push(scratch);
  return scratch;
};

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), 'bashle-source-'));
});

afterEach(async () => {
  for (const scratch of open.splice(0)) await scratch.dispose();
  rmSync(source, { recursive: true, force: true });
});

describe('createScratchClone', () => {
  it('copies ordinary files', async () => {
    write('script.sh', 'echo hi\n');
    write('lib/helper.sh');
    const { root } = await clone();
    expect(readFileSync(join(root, 'script.sh'), 'utf8')).toBe('echo hi\n');
    expect(existsSync(join(root, 'lib/helper.sh'))).toBe(true);
  });

  it('skips .git and node_modules without an ignore file', async () => {
    write('.git/HEAD', 'ref: refs/heads/main\n');
    write('node_modules/left-pad/index.js');
    write('keep.sh');
    const { root } = await clone();
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'keep.sh'))).toBe(true);
  });

  it('skips paths matched by .bashleignore at any depth', async () => {
    write('.bashleignore', '*.log\n# a comment\n');
    write('run.log');
    write('deep/nested/other.log');
    write('deep/nested/keep.txt');
    const { root } = await clone();
    expect(existsSync(join(root, 'run.log'))).toBe(false);
    expect(existsSync(join(root, 'deep/nested/other.log'))).toBe(false);
    expect(existsSync(join(root, 'deep/nested/keep.txt'))).toBe(true);
  });

  it('anchors a pattern containing a slash to the workspace root', async () => {
    write('.bashleignore', 'build/out\n');
    write('build/out/artifact.bin');
    write('sub/build/out/artifact.bin');
    const { root } = await clone();
    expect(existsSync(join(root, 'build/out'))).toBe(false);
    expect(existsSync(join(root, 'sub/build/out/artifact.bin'))).toBe(true);
  });

  it('lets a negation re-include a default-ignored directory', async () => {
    write('.bashleignore', '!node_modules\n');
    write('node_modules/left-pad/index.js');
    write('.git/HEAD');
    const { root } = await clone();
    expect(existsSync(join(root, 'node_modules/left-pad/index.js'))).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('keeps the unignored siblings of an ignored path', async () => {
    write('.bashleignore', 'pkg/vendor\n');
    write('pkg/vendor/blob.bin');
    write('pkg/main.sh');
    write('pkg/sub/deep.sh');
    const { root } = await clone();
    expect(existsSync(join(root, 'pkg/vendor'))).toBe(false);
    expect(existsSync(join(root, 'pkg/main.sh'))).toBe(true);
    expect(existsSync(join(root, 'pkg/sub/deep.sh'))).toBe(true);
  });

  it('copies a symlink as a symlink rather than following it', async () => {
    write('target.txt', 'payload\n');
    write('.bashleignore', 'ignored\n');
    symlinkSync('target.txt', join(source, 'link.txt'));
    const { root } = await clone();
    expect(lstatSync(join(root, 'link.txt')).isSymbolicLink()).toBe(true);
  });

  it('refuses a workspace whose copied files exceed the limit', async () => {
    write('big.bin', 'a'.repeat(200_000));
    await expect(clone(100_000)).rejects.toBeInstanceOf(WorkspaceTooLargeError);
  });

  it('does not count ignored files against the limit', async () => {
    write('.bashleignore', 'node_modules\n');
    write('node_modules/big.bin', 'a'.repeat(200_000));
    write('small.sh');
    const { root } = await clone(100_000);
    expect(existsSync(join(root, 'small.sh'))).toBe(true);
  });
});
