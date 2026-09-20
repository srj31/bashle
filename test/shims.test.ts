import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, open } from 'node:fs/promises';
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

  describe('the file-reader tier', () => {
    it('passes through to the real binary when every file argument exists', async () => {
      await writeFile(join(root, 'present.txt'), 'real contents\n');
      await generateShims({ binDirectory, fills: [] });

      const { stdout, code, trace } = await invoke('cat', [join(root, 'present.txt')]);
      expect(stdout).toBe('real contents\n');
      expect(code).toBe(0);
      expect(trace).toBe('');
    });

    it('passes through with several files, concatenating as the real binary does', async () => {
      await writeFile(join(root, 'a.txt'), 'A\n');
      await writeFile(join(root, 'b.txt'), 'B\n');
      await generateShims({ binDirectory, fills: [] });

      const { stdout } = await invoke('cat', [join(root, 'a.txt'), join(root, 'b.txt')]);
      expect(stdout).toBe('A\nB\n');
    });

    it('holes on a missing file and lets the run continue', async () => {
      await generateShims({ binDirectory, fills: [] });
      const { stdout, code, trace } = await invoke('cat', [join(root, 'absent.txt')]);

      expect(code).toBe(0);
      expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
      expect(trace).toContain('absent.txt');
      expect(trace).toContain('open');
    });

    it('holes on only the missing file when one of two exists', async () => {
      await writeFile(join(root, 'present.txt'), 'A\n');
      await generateShims({ binDirectory, fills: [] });

      const { trace } = await invoke('head', [
        '-n', '2', join(root, 'present.txt'), join(root, 'gone.txt'),
      ]);
      expect(trace).toContain('gone.txt');
      expect(trace).not.toContain('present.txt');
    });

    it('does not mistake a flag or a lone dash for a missing file', async () => {
      await writeFile(join(root, 'present.txt'), 'A\n');
      await generateShims({ binDirectory, fills: [] });

      const { trace, stdout } = await invoke('head', ['-n', '1', join(root, 'present.txt')]);
      expect(trace).toBe('');
      expect(stdout).toBe('A\n');
    });

    it('passes a directory through so it fails the way the real binary would', async () => {
      await generateShims({ binDirectory, fills: [] });
      const { code, trace } = await invoke('cat', [root]);
      expect(code).not.toBe(0);
      expect(trace).toBe('');
    });
  });

  describe('the pre-filled tier', () => {
    it('pins the clock while still letting date format', async () => {
      await generateShims({ binDirectory, fills: [] });
      const { stdout } = await invoke('date', ['-u', '+%Y-%m-%d']);
      expect(stdout.trim()).toBe('2026-01-01');
    });

    it('takes the pinned instant from @clock', async () => {
      await generateShims({
        binDirectory,
        fills: [fill({ kind: 'clock', request: '', body: '2026-01-15T09:30:00Z' })],
      });
      const { stdout } = await invoke('date', ['-u', '+%Y-%m-%d']);
      expect(stdout.trim()).toBe('2026-01-15');
    });

    it('answers hostname without counting as an unknown', async () => {
      await generateShims({ binDirectory, fills: [] });
      const { stdout, trace } = await invoke('hostname', []);
      expect(stdout.trim()).toBe('bashle');
      expect(trace).toContain('prefilled');
      expect(trace).not.toContain('open');
    });

    it('lets a @cmd fill override a pre-filled default', async () => {
      await generateShims({
        binDirectory,
        fills: [fill({ kind: 'cmd', request: 'hostname', body: 'build-box' })],
      });
      const { stdout } = await invoke('hostname', []);
      expect(stdout).toBe('build-box');
    });
  });
});