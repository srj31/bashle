import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, rm, readFile, writeFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateShims, HOLE_SENTINEL_PATTERN } from '../src/shims';
import type { Fill } from '../src/types';

const SHIPPED_SHIMS = resolve(__dirname, '..', 'resources', 'shims');

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
  ): Promise<{ stdout: string; stderr: string; code: number; trace: string }> {
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
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
        child.stderr?.on('data', (chunk: Buffer) => errorChunks.push(chunk));
        child.on('error', reject);
        child.on('close', (status) => resolve(status ?? 0));
      });
      return {
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errorChunks).toString('utf8'),
        code,
        trace: await readFile(tracePath, 'utf8'),
      };
    } finally {
      await handle.close();
    }
  }

  it('answers an unmatched request with a sentinel and a zero exit, so set -e cannot end the run', async () => {
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
    const { stdout, code, trace } = await invoke('curl', ['-s', 'https://api.example.com/v1/x']);

    expect(code).toBe(0);
    expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
    expect(trace).toContain('GET https://api.example.com/v1/x');
    expect(trace).toContain('open');
  });

  it('answers a matched request with the fill body and its exit status', async () => {
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [fill({ body: '1.4.2', exitCode: 0 })] });
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
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [fill({ body: nasty })] });
    const { stdout } = await invoke('curl', ['https://api.example.com/v1/latest']);
    expect(stdout).toBe(nasty);
  });

  it('matches a request containing glob characters literally rather than as a pattern', async () => {
    await generateShims({
      binDirectory,
      sourceDirectory: SHIPPED_SHIMS,
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
      sourceDirectory: SHIPPED_SHIMS,
      fills: [fill({ request: 'GET https://api/health', body: '', exitCode: 22 })],
    });
    const { code } = await invoke('curl', ['-f', '-s', 'https://api/health']);
    expect(code).toBe(22);
  });

  it('reads the method from -X, so the same URL can answer differently per verb', async () => {
    await generateShims({
      binDirectory,
      sourceDirectory: SHIPPED_SHIMS,
      fills: [fill({ request: 'POST https://api/v1/deploy', body: 'queued' })],
    });
    const posted = await invoke('curl', ['-X', 'POST', 'https://api/v1/deploy']);
    expect(posted.stdout).toBe('queued');

    const got = await invoke('curl', ['https://api/v1/deploy']);
    expect(got.stdout).toMatch(HOLE_SENTINEL_PATTERN);
  });

  it('reads -d as a POST, so a form post matches a POST fill', async () => {
    await generateShims({
      binDirectory,
      sourceDirectory: SHIPPED_SHIMS,
      fills: [fill({ request: 'POST https://api/v1/deploy', body: 'queued' })],
    });
    const { stdout } = await invoke('curl', ['-d', 'ref=main', 'https://api/v1/deploy']);
    expect(stdout).toBe('queued');
  });

  it('answers wget from the same @net fills as curl', async () => {
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [fill({ body: '1.4.2' })] });
    const { stdout, trace } = await invoke('wget', ['-qO-', 'https://api.example.com/v1/latest']);
    expect(stdout).toBe('1.4.2');
    expect(trace).toContain('filled');
  });

  it('answers only the exact request, so the same URL with a query string is a hole', async () => {
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [fill({ body: '1.4.2' })] });
    const { stdout, trace } = await invoke('curl', ['https://api.example.com/v1/latest?channel=beta']);
    expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
    expect(trace).toContain('GET https://api.example.com/v1/latest?channel=beta');
  });

  it('honours -o by writing the body to that path instead of stdout', async () => {
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [fill({ body: 'downloaded' })] });
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
      sourceDirectory: SHIPPED_SHIMS,
      fills: [fill({ kind: 'cmd', request: 'docker ps -a', body: 'CONTAINER ID' })],
    });

    const matched = await invoke('docker', ['ps', '-a']);
    expect(matched.stdout).toBe('CONTAINER ID');

    const unmatched = await invoke('docker', ['ps']);
    expect(unmatched.stdout).toMatch(HOLE_SENTINEL_PATTERN);
  });

  it("returns a @cmd fill's exit status", async () => {
    await generateShims({
      binDirectory,
      sourceDirectory: SHIPPED_SHIMS,
      fills: [fill({ kind: 'cmd', request: 'kubectl rollout status deploy/web', body: '', exitCode: 1 })],
    });
    const { stdout, code } = await invoke('kubectl', ['rollout', 'status', 'deploy/web']);
    expect(stdout).toBe('');
    expect(code).toBe(1);
  });

  it('does not run the real binary for a sandbox-escaping command', async () => {
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
    const { stdout, code } = await invoke('docker', ['version']);
    expect(code).toBe(0);
    expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
  });

  describe('the file-reader tier', () => {
    it('passes through to the real binary when every file argument exists', async () => {
      await writeFile(join(root, 'present.txt'), 'real contents\n');
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });

      const { stdout, code, trace } = await invoke('cat', [join(root, 'present.txt')]);
      expect(stdout).toBe('real contents\n');
      expect(code).toBe(0);
      expect(trace).toBe('');
    });

    it('passes through with several files, concatenating as the real binary does', async () => {
      await writeFile(join(root, 'a.txt'), 'A\n');
      await writeFile(join(root, 'b.txt'), 'B\n');
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });

      const { stdout } = await invoke('cat', [join(root, 'a.txt'), join(root, 'b.txt')]);
      expect(stdout).toBe('A\nB\n');
    });

    it('holes on a missing file and lets the run continue', async () => {
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
      const { stdout, code, trace } = await invoke('cat', [join(root, 'absent.txt')]);

      expect(code).toBe(0);
      expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
      expect(trace).toContain('absent.txt');
      expect(trace).toContain('open');
    });

    it('holes on only the missing file when one of two exists', async () => {
      await writeFile(join(root, 'present.txt'), 'A\n');
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });

      const { trace } = await invoke('head', [
        '-n', '2', join(root, 'present.txt'), join(root, 'gone.txt'),
      ]);
      expect(trace).toContain('gone.txt');
      expect(trace).not.toContain('present.txt');
    });

    it('does not mistake a flag or a lone dash for a missing file', async () => {
      await writeFile(join(root, 'present.txt'), 'A\n');
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });

      const { trace, stdout } = await invoke('head', ['-n', '1', join(root, 'present.txt')]);
      expect(trace).toBe('');
      expect(stdout).toBe('A\n');
    });

    it('passes a directory through so it fails the way the real binary would', async () => {
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
      const { code, trace } = await invoke('cat', [root]);
      expect(code).not.toBe(0);
      expect(trace).toBe('');
    });
  });

  describe('the pre-filled tier', () => {
    it('pins the clock while still letting date format', async () => {
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
      const { stdout } = await invoke('date', ['-u', '+%Y-%m-%d']);
      expect(stdout.trim()).toBe('2026-01-01');
    });

    it('takes the pinned instant from @clock', async () => {
      await generateShims({
        binDirectory,
        sourceDirectory: SHIPPED_SHIMS,
        fills: [fill({ kind: 'clock', request: '', body: '2026-01-15T09:30:00Z' })],
      });
      const { stdout } = await invoke('date', ['-u', '+%Y-%m-%d']);
      expect(stdout.trim()).toBe('2026-01-15');
    });

    it('answers hostname without counting as an unknown', async () => {
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
      const { stdout, trace } = await invoke('hostname', []);
      expect(stdout.trim()).toBe('bashle');
      expect(trace).toContain('prefilled');
      expect(trace).not.toContain('open');
    });

    it('answers only the date command a @cmd fill names, and reads the pinned clock otherwise', async () => {
      await generateShims({
        binDirectory,
        sourceDirectory: SHIPPED_SHIMS,
        fills: [fill({ kind: 'cmd', request: 'date -u +%Y', body: '1999' })],
      });
      expect((await invoke('date', ['-u', '+%Y'])).stdout).toBe('1999');
      expect((await invoke('date', ['-u', '+%m'])).stdout).toBe('01\n');
    });

    it('lets a @cmd fill override a pre-filled default', async () => {
      await generateShims({
        binDirectory,
        sourceDirectory: SHIPPED_SHIMS,
        fills: [fill({ kind: 'cmd', request: 'hostname', body: 'build-box' })],
      });
      const { stdout } = await invoke('hostname', []);
      expect(stdout).toBe('build-box');
    });

    it.each([
      ['whoami', 'bashle\n'],
      ['uuidgen', '00000000-0000-4000-8000-000000000000\n'],
    ])('answers %s from its fixed default', async (name, expected) => {
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
      const { stdout, trace } = await invoke(name, []);
      expect(stdout).toBe(expected);
      expect(trace).toContain('prefilled');
    });
  });

  // A shim's stderr is the script's own, so anything written there would read
  // as something the script printed.
  it.each([
    ['curl', ['https://api.example.com/v1/latest']],
    ['wget', ['-qO-', 'https://example.com/unfilled']],
    ['docker', ['ps']],
    ['cat', ['/nonexistent/bashle/file']],
    ['hostname', []],
    ['date', ['-u', '+%Y']],
  ])('%s writes nothing to stderr', async (name, args) => {
    await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [fill({ body: '1.4.2' })] });
    const { stderr } = await invoke(name, args);
    expect(stderr).toBe('');
  });

  // A name dropped from a header would let the real program run, and these
  // reach past the file sandbox, so each one is checked by name.
  it.each(['curl', 'wget', 'nc', 'docker', 'systemctl', 'launchctl', 'ssh', 'aws', 'kubectl'])(
    'answers %s with a hole rather than running it',
    async (name) => {
      await generateShims({ binDirectory, sourceDirectory: SHIPPED_SHIMS, fills: [] });
      const { stdout, code, trace } = await invoke(name, ['https://example.com/x']);
      expect(code).toBe(0);
      expect(stdout).toMatch(HOLE_SENTINEL_PATTERN);
      expect(trace).toContain('open');
    },
  );

  describe('the shim directory', () => {
    let sourceDirectory: string;

    beforeEach(async () => {
      sourceDirectory = join(root, 'shim-sources');
      await mkdir(sourceDirectory);
      await writeFile(join(sourceDirectory, '_preamble.sh'), "_greeting='hello from'\n");
    });

    const shimFile = (file: string, contents: string) =>
      writeFile(join(sourceDirectory, file), contents);

    it('writes one executable per name in a header, running the preamble before the file', async () => {
      await shimFile('greet.sh', '# shims: alpha beta\nprintf \'%s %s\' "$_greeting" "$_bashle_name"\n');
      await generateShims({ binDirectory, sourceDirectory, fills: [] });

      expect((await invoke('alpha', [])).stdout).toBe('hello from alpha');
      expect((await invoke('beta', [])).stdout).toBe('hello from beta');
    });

    it('hands a file only the fills of the kind its header names, and none without one', async () => {
      const printFills =
        'printf \'%s|\' "$_bashle_name" "${_bashle_fill_requests[@]}" ' +
        '"${_bashle_fill_bodies[@]}" "${_bashle_fill_codes[@]}"\n';
      await shimFile('wants-cmd.sh', `# shims: alpha\n# fills: cmd\n${printFills}`);
      await shimFile('wants-none.sh', `# shims: beta\n${printFills}`);
      await generateShims({
        binDirectory,
        sourceDirectory,
        fills: [
          fill({ kind: 'net', request: 'GET https://x', body: 'from net' }),
          fill({ kind: 'cmd', request: "alpha 'go'", body: 'it\'s "done"\n', exitCode: 3 }),
        ],
      });

      expect((await invoke('alpha', [])).stdout).toBe(`alpha|alpha 'go'|it's "done"\n|3|`);
      expect((await invoke('beta', [])).stdout).toBe('beta|');
    });

    it('gives a file the real binary it asks for, and skips a name that has none', async () => {
      await shimFile(
        'delegate.sh',
        '# shims: cat bashle-no-such-binary\n# real-binary: required\nprintf \'%s\' "$_bashle_real"\n',
      );
      await generateShims({ binDirectory, sourceDirectory, fills: [] });

      expect((await invoke('cat', [])).stdout).toMatch(/^\/.*\/cat$/);
      await expect(access(join(binDirectory, 'bashle-no-such-binary'))).rejects.toThrow();
    });

    it('ignores ordinary comments after the header and files that are not shims', async () => {
      await shimFile('greet.sh', '# shims: alpha\n\n# Note: prose, not a header.\nprintf hi\n');
      await writeFile(join(sourceDirectory, 'README.md'), '# shims: gamma\n');
      await generateShims({ binDirectory, sourceDirectory, fills: [] });

      expect((await invoke('alpha', [])).stdout).toBe('hi');
      await expect(access(join(binDirectory, 'gamma'))).rejects.toThrow();
    });

    it('refuses two files that claim the same command', async () => {
      await shimFile('one.sh', '# shims: alpha dup\n');
      await shimFile('two.sh', '# shims: dup\n');
      await expect(generateShims({ binDirectory, sourceDirectory, fills: [] })).rejects.toThrow(
        /dup.*one\.sh.*two\.sh/,
      );
    });

    it.each([
      ['no shims line', '# fills: cmd\n'],
      ['a mistyped key', '# shim: alpha\n'],
      ['an unknown fill kind', '# shims: alpha\n# fills: network\n'],
      ['a real-binary value other than required', '# shims: alpha\n# real-binary: yes\n'],
    ])('refuses a header with %s, naming the file', async (_, contents) => {
      await shimFile('broken.sh', contents);
      await expect(generateShims({ binDirectory, sourceDirectory, fills: [] })).rejects.toThrow(
        /broken\.sh/,
      );
    });
  });
});