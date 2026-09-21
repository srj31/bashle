import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { buildBubblewrapArgs, buildSeatbeltArgs, SANDBOX_EXEC } from '../src/sandbox';

const run = promisify(execFile);
const PROFILE_PATH = resolve(__dirname, '..', 'resources', 'sandbox.sb');
const profile = readFileSync(PROFILE_PATH, 'utf8');

const onDarwin = it.runIf(process.platform === 'darwin');

describe('the seatbelt profile', () => {
  it('declares the version ahead of any rule', () => {
    const directives = profile.split('\n').filter((line) => line.trim() && !line.trim().startsWith(';;'));
    expect(directives[0]).toBe('(version 1)');
  });

  it('denies writes everywhere before re-allowing the scratch root', () => {
    expect(profile.indexOf('(deny file-write*)')).toBeLessThan(profile.indexOf('(param "SCRATCH_ROOT")'));
  });

  it('takes the scratch root as a parameter rather than baking a path in', () => {
    expect(profile).toContain('(subpath (param "SCRATCH_ROOT"))');
  });

  it('denies the network', () => {
    expect(profile).toContain('(deny network*)');
  });

  it('denies executing sudo', () => {
    expect(profile).toContain('(deny process-exec');
    expect(profile).toContain('/usr/bin/sudo');
  });

  it('keeps the character devices a script needs writable', () => {
    for (const device of ['/dev/null', '/dev/stdout', '/dev/stderr']) {
      expect(profile).toContain(device);
    }
  });

  it('does not blanket-allow the system temp area', () => {
    expect(profile).not.toContain('/private/var/folders');
    expect(profile).not.toContain('/tmp"');
  });

  it('grants nothing writable beyond the parameter and the character devices', () => {
    const allowBlock = profile.split('(allow file-write*')[1] ?? '';
    const grantedPaths = [...allowBlock.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1]!.replace(/^\^/, ''))
      .filter((granted) => granted !== 'SCRATCH_ROOT');
    for (const granted of grantedPaths) {
      expect(granted.startsWith('/dev/')).toBe(true);
    }
  });
});

describe('buildSeatbeltArgs', () => {
  const argsFor = (scratchRoot = '/tmp/bashle/run1') =>
    buildSeatbeltArgs({ profilePath: '/ext/resources/sandbox.sb', scratchRoot });

  it('points seatbelt at the shipped profile', () => {
    expect(argsFor()).toEqual(['-D', 'SCRATCH_ROOT=/tmp/bashle/run1', '-f', '/ext/resources/sandbox.sb']);
  });

  it('passes an awkward path as one argv word, with no quoting to escape', () => {
    const args = argsFor('/tmp/we"ird\\path');
    expect(args).toContain('SCRATCH_ROOT=/tmp/we"ird\\path');
  });
});

// A typo in the SBPL would pass every assertion on its text, so these run it for real.
describe('the seatbelt profile, enforced', () => {
  const sandboxed = async (scratchRoot: string, script: string) => {
    const args = [...buildSeatbeltArgs({ profilePath: PROFILE_PATH, scratchRoot }), '/bin/bash', '-c', script];
    return run(SANDBOX_EXEC, args).catch((error: Error & { stdout?: string; stderr?: string }) => ({
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    }));
  };

  let scratchRoot: string;
  let cleanup: () => Promise<void>;

  const withScratch = async () => {
    scratchRoot = await realpath(await mkdtemp(join(tmpdir(), 'bashle-sb-')));
    cleanup = () => rm(scratchRoot, { recursive: true, force: true });
    return scratchRoot;
  };

  onDarwin('compiles, and lets the run write inside the scratch root', async () => {
    const root = await withScratch();
    try {
      const { stdout, stderr } = await sandboxed(root, `echo hello > ${root}/note && cat ${root}/note`);
      expect(stderr).not.toMatch(/sandbox-exec|profile/i);
      expect(stdout.trim()).toBe('hello');
    } finally {
      await cleanup();
    }
  });

  onDarwin('refuses a write outside the scratch root', async () => {
    const root = await withScratch();
    try {
      const outside = join(root, '..', `bashle-escape-${process.pid}`);
      const { stderr } = await sandboxed(root, `echo x > ${outside}`);
      expect(stderr).toMatch(/not permitted/i);
    } finally {
      await cleanup();
    }
  });

  onDarwin('refuses to execute sudo', async () => {
    const root = await withScratch();
    try {
      const { stderr } = await sandboxed(root, '/usr/bin/sudo -n true');
      expect(stderr).toMatch(/not permitted/i);
    } finally {
      await cleanup();
    }
  });
});

describe('buildBubblewrapArgs', () => {
  const argsFor = (over: Partial<Parameters<typeof buildBubblewrapArgs>[0]> = {}) =>
    buildBubblewrapArgs({ writableRoots: ['/tmp/bashle/run1'], workingDirectory: '/tmp/bashle/run1', ...over });

  const pairIndex = (args: string[], flag: string, value: string) =>
    args.findIndex((arg, i) => arg === flag && args[i + 1] === value);

  it('binds the whole filesystem read-only before anything else', () => {
    expect(argsFor().slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
  });

  it('re-binds the scratch root writable, after the read-only root', () => {
    const args = argsFor();
    expect(pairIndex(args, '--bind', '/tmp/bashle/run1')).toBeGreaterThan(
      pairIndex(args, '--ro-bind', '/'),
    );
  });

  it('allows several writable roots', () => {
    const args = argsFor({ writableRoots: ['/tmp/a', '/tmp/b'] });
    expect(pairIndex(args, '--bind', '/tmp/a')).toBeGreaterThan(-1);
    expect(pairIndex(args, '--bind', '/tmp/b')).toBeGreaterThan(-1);
  });

  it('denies the network', () => {
    expect(argsFor()).toContain('--unshare-net');
    expect(argsFor({ allowNetwork: true })).not.toContain('--unshare-net');
  });

  it('masks the privilege-escalation binaries it was told exist', () => {
    const args = argsFor({ blockedExecutables: ['/usr/bin/sudo'] });
    expect(args.join(' ')).toContain('--ro-bind /dev/null /usr/bin/sudo');
  });

  it('asks for no mask when none of those binaries are installed', () => {
    expect(argsFor({ blockedExecutables: [] }).join(' ')).not.toContain('/dev/null');
  });

  it('gives the run its own /dev and /proc so character devices stay usable', () => {
    const args = argsFor();
    expect(pairIndex(args, '--dev', '/dev')).toBeGreaterThan(-1);
    expect(pairIndex(args, '--proc', '/proc')).toBeGreaterThan(-1);
  });

  it('makes the sandbox init of a pid namespace so a timeout kill takes everything with it', () => {
    expect(argsFor()).toContain('--unshare-pid');
    expect(argsFor()).toContain('--die-with-parent');
  });

  it('starts the run in the scratch clone', () => {
    expect(pairIndex(argsFor(), '--chdir', '/tmp/bashle/run1')).toBeGreaterThan(-1);
  });

  it('ends the options with -- so the command cannot be read as one', () => {
    expect(argsFor().at(-1)).toBe('--');
  });
});

describe('buildBubblewrapArgs containment', () => {
  it('grants nothing writable beyond the roots it was given', () => {
    const args = buildBubblewrapArgs({
      writableRoots: ['/tmp/bashle/run1'],
      workingDirectory: '/tmp/bashle/run1',
    });
    const writableBinds = args.filter((arg, i) => args[i - 1] === '--bind');
    expect(writableBinds).toEqual(['/tmp/bashle/run1']);
  });
});
