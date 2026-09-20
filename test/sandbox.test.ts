import { describe, it, expect } from 'vitest';
import { buildBubblewrapArgs, buildSandboxProfile } from '../src/sandbox';

const profileFor = (over: Partial<Parameters<typeof buildSandboxProfile>[0]> = {}) =>
  buildSandboxProfile({ writableRoots: ['/tmp/bashle/run1'], ...over });

describe('buildSandboxProfile', () => {
  it('denies writes everywhere before re-allowing the scratch root', () => {
    const profile = profileFor();
    expect(profile.indexOf('(deny file-write*)')).toBeLessThan(
      profile.indexOf('/tmp/bashle/run1'),
    );
    expect(profile).toContain('(subpath "/tmp/bashle/run1")');
  });

  it('denies the network', () => {
    expect(profileFor()).toContain('(deny network*)');
  });

  it('denies executing sudo', () => {
    expect(profileFor()).toContain('(deny process-exec');
    expect(profileFor()).toContain('/usr/bin/sudo');
  });

  it('keeps the character devices a script needs writable', () => {
    const profile = profileFor();
    for (const device of ['/dev/null', '/dev/stdout', '/dev/stderr']) {
      expect(profile).toContain(device);
    }
  });

  it('allows several writable roots', () => {
    const profile = profileFor({ writableRoots: ['/tmp/a', '/tmp/b'] });
    expect(profile).toContain('(subpath "/tmp/a")');
    expect(profile).toContain('(subpath "/tmp/b")');
  });

  it('escapes quotes and backslashes in paths so the profile cannot be broken out of', () => {
    const profile = profileFor({ writableRoots: ['/tmp/we"ird\\path'] });
    expect(profile).toContain('(subpath "/tmp/we\\"ird\\\\path")');
  });

  it('starts with a version declaration seatbelt accepts', () => {
    expect(profileFor().trimStart().startsWith('(version 1)')).toBe(true);
  });
});

describe('buildSandboxProfile containment', () => {
  it('does not blanket-allow the system temp area', () => {
    const profile = profileFor();
    expect(profile).not.toContain('/private/var/folders');
    expect(profile).not.toContain('/tmp"');
  });

  it('grants nothing writable beyond the roots and character devices it was given', () => {
    const allowBlock = profileFor().split('(allow file-write*')[1] ?? '';
    const grantedPaths = [...allowBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.replace(/^\^/, ''));
    for (const granted of grantedPaths) {
      expect(granted === '/tmp/bashle/run1' || granted.startsWith('/dev/')).toBe(true);
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
