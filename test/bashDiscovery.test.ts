import { describe, it, expect } from 'vitest';
import { parseBashVersion, meetsMinimumVersion, MINIMUM_BASH } from '../src/bashDiscovery';

describe('parseBashVersion', () => {
  it('reads the version out of the banner', () => {
    const banner = 'GNU bash, version 5.2.26(1)-release (aarch64-apple-darwin24)';
    expect(parseBashVersion(banner)).toEqual({ version: '5.2.26', major: 5, minor: 2 });
  });

  it('reads the macOS system bash banner', () => {
    const banner = 'GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)';
    expect(parseBashVersion(banner)).toEqual({ version: '3.2.57', major: 3, minor: 2 });
  });

  it('returns null for output that is not a bash banner', () => {
    expect(parseBashVersion('zsh 5.9')).toBeNull();
    expect(parseBashVersion('')).toBeNull();
  });
});

describe('meetsMinimumVersion', () => {
  it('rejects the bash that ships with macOS', () => {
    expect(meetsMinimumVersion({ version: '3.2.57', major: 3, minor: 2 })).toBe(false);
  });

  it('accepts the first release with BASH_XTRACEFD', () => {
    expect(meetsMinimumVersion({ version: '4.1.0', major: 4, minor: 1 })).toBe(true);
  });

  it('rejects the release just before it', () => {
    expect(meetsMinimumVersion({ version: '4.0.0', major: 4, minor: 0 })).toBe(false);
  });

  it('accepts modern bash', () => {
    expect(meetsMinimumVersion({ version: '5.2.26', major: 5, minor: 2 })).toBe(true);
  });

  it('states the minimum it enforces', () => {
    expect(MINIMUM_BASH).toEqual({ major: 4, minor: 1 });
  });
});
