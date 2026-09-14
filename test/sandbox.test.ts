import { describe, it, expect } from 'vitest';
import { buildSandboxProfile } from '../src/sandbox';

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
