import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateShims, HOLE_SENTINEL_PATTERN } from '../src/shims';
import type { Fill } from '../src/types';

const fill = (over: Partial<Fill>): Fill => ({
  kind: 'net',
  request: 'GET https://api.example.com/v1/latest',
  body: '1.4.2',
  exitCode: 0,
  lineIndex: 0,
  ...over,
});

describe('generated shims', () => {
  let root: string;
  let binDirectory: string;
  let tracePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bashle-shim-'));
    binDirectory = join(root, 'bin');
    tracePath = join(root, 'trace');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Runs a generated shim with fd 9 pointed at a file, as the real run does. */
  async function invoke(
    name: string,
    args: string[],
  ): Promise<{ stdout: string; code: number; trace: string }> {
    const chunks: Buffer[] = [];
    const handle = await open(tracePath, 'w');
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(join(binDirectory, name), args, {
          stdio: [
            'ignore', 'pipe', 'pipe',
            'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore',
            handle.fd,
          ],
        });
        child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.on('error', reject);
        child.on('close', (status) => resolve(status ?? 0));
      });
      return {
        stdout: Buffer.concat(chunks).toString('utf8'),
        code,
        trace: await readFile(tracePath, 'utf8'),
      };
    } finally {
      await handle.close();
    }
  }

  it('answers an unmatched request with a sentinel and a zero exit, so set -e cannot end the run', async () => {
    await generateShims({ binDirectory, fills: [] });
    const { stdout, code, trace } = await invoke('curl', ['-s', 'https://api.example.com/v1/x']);

    expect(code).toBe(0);
    expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
    expect(trace).toContain('GET https://api.example.com/v1/x');
    expect(trace).toContain('open');
  });

  it('answers a matched request with the fill body and its exit status', async () => {
    await generateShims({ binDirectory, fills: [fill({ body: '1.4.2', exitCode: 0 })] });
    const { stdout, code, trace } = await invoke('curl', [
      '-s',
      'https://api.example.com/v1/latest',
    ]);

    expect(stdout).toBe('1.4.2');
    expect(code).toBe(0);
    expect(trace).toContain('filled');
    expect(stdout).not.toMatch(HOLE_SENTINEL_PATTERN);
  });

  it('carries a body containing quotes, newlines, $, backticks and glob characters intact', async () => {
    const nasty = `it's "quoted" $HOME \`whoami\` * ? [a-z]\nsecond line\n`;
    await generateShims({ binDirectory, fills: [fill({ body: nasty })] });
    const { stdout } = await invoke('curl', ['https://api.example.com/v1/latest']);
    expect(stdout).toBe(nasty);
  });

  it('matches a request containing glob characters literally rather than as a pattern', async () => {
    await generateShims({
      binDirectory,
      fills: [fill({ request: 'GET https://api.example.com/v1/*', body: 'star' })],
    });

    const wrong = await invoke('curl', ['https://api.example.com/v1/latest']);
    expect(wrong.stdout).toMatch(HOLE_SENTINEL_PATTERN);

    const right = await invoke('curl', ['https://api.example.com/v1/*']);
    expect(right.stdout).toBe('star');
  });

  it('returns the fill exit status', async () => {
    await generateShims({
      binDirectory,
      fills: [fill({ request: 'GET https://api/health', body: '', exitCode: 22 })],
    });
    const { code } = await invoke('curl', ['-f', '-s', 'https://api/health']);
    expect(code).toBe(22);
  });

  it('reads the method from -X, so the same URL can answer differently per verb', async () => {
    await generateShims({
      binDirectory,
      fills: [fill({ request: 'POST https://api/v1/deploy', body: 'queued' })],
    });
    const posted = await invoke('curl', ['-X', 'POST', 'https://api/v1/deploy']);
    expect(posted.stdout).toBe('queued');

    const got = await invoke('curl', ['https://api/v1/deploy']);
    expect(got.stdout).toMatch(HOLE_SENTINEL_PATTERN);
  });

  it('honours -o by writing the body to that path instead of stdout', async () => {
    await generateShims({ binDirectory, fills: [fill({ body: 'downloaded' })] });
    const target = join(root, 'out.txt');
    const { stdout } = await invoke('curl', [
      '-o', target, 'https://api.example.com/v1/latest',
    ]);

    expect(stdout).toBe('');
    expect(await readFile(target, 'utf8')).toBe('downloaded');
  });

  it('keys a sandbox-escaping command on its whole argv', async () => {
    await generateShims({
      binDirectory,
      fills: [fill({ kind: 'cmd', request: 'docker ps -a', body: 'CONTAINER ID' })],
    });

    const matched = await invoke('docker', ['ps', '-a']);
    expect(matched.stdout).toBe('CONTAINER ID');

    const unmatched = await invoke('docker', ['ps']);
    expect(unmatched.stdout).toMatch(HOLE_SENTINEL_PATTERN);
  });

  it('does not run the real binary for a sandbox-escaping command', async () => {
    await generateShims({ binDirectory, fills: [] });
    const { stdout, code } = await invoke('docker', ['version']);
    expect(code).toBe(0);
    expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
  });
});