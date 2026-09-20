import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeFileFills } from '../src/fills';
import type { Fill } from '../src/types';

const fileFill = (over: Partial<Fill> = {}): Fill => ({
  kind: 'file',
  request: 'etc/deploy.conf',
  body: 'target=staging',
  exitCode: 0,
  lineIndex: 0,
  ...over,
});

describe('materializeFileFills', () => {
  let workspaceRoot: string;
  let scratchRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'bashle-ws-'));
    scratchRoot = await mkdtemp(join(tmpdir(), 'bashle-scratch-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it('writes an inline body into the clone, creating the parent directories', async () => {
    const { warnings } = await materializeFileFills({
      fills: [fileFill()],
      workspaceRoot,
      scratchRoot,
    });
    expect(warnings).toEqual([]);
    expect(await readFile(join(scratchRoot, 'etc/deploy.conf'), 'utf8')).toBe('target=staging');
  });

  it('resolves a fixture reference against the workspace root', async () => {
    await mkdir(join(workspaceRoot, 'fixtures'), { recursive: true });
    await writeFile(join(workspaceRoot, 'fixtures/manifest.json'), '{"v":1}', 'utf8');

    const { warnings } = await materializeFileFills({
      fills: [fileFill({ request: 'build/manifest.json', body: '', fixture: 'fixtures/manifest.json' })],
      workspaceRoot,
      scratchRoot,
    });

    expect(warnings).toEqual([]);
    expect(await readFile(join(scratchRoot, 'build/manifest.json'), 'utf8')).toBe('{"v":1}');
  });

  it('warns and writes nothing when the fixture is missing', async () => {
    const { warnings } = await materializeFileFills({
      fills: [fileFill({ fixture: 'fixtures/gone.json' })],
      workspaceRoot,
      scratchRoot,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/fixtures\/gone\.json/);
    await expect(readFile(join(scratchRoot, 'etc/deploy.conf'), 'utf8')).rejects.toThrow();
  });

  it('refuses a request that would escape the clone', async () => {
    const { warnings } = await materializeFileFills({
      fills: [fileFill({ request: '../escaped.conf' })],
      workspaceRoot,
      scratchRoot,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/escaped\.conf/);
  });

  it('refuses an absolute request, which materialization cannot place', async () => {
    const { warnings } = await materializeFileFills({
      fills: [fileFill({ request: '/etc/deploy.conf' })],
      workspaceRoot,
      scratchRoot,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\/etc\/deploy\.conf/);
    await expect(readFile(join(scratchRoot, 'etc/deploy.conf'), 'utf8')).rejects.toThrow();
  });

  it('ignores fills that are not file fills', async () => {
    const { warnings } = await materializeFileFills({
      fills: [fileFill({ kind: 'net', request: 'GET https://api/x', body: '1.4.2' })],
      workspaceRoot,
      scratchRoot,
    });
    expect(warnings).toEqual([]);
  });
});
