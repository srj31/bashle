import { describe, it, expect } from 'vitest';
import { describeUnavailable, discoverContainment, planContainment } from '../src/containment';
import { buildCommand } from '../src/runner';

const SCRATCH = { scratchRoot: '/tmp/bashle/run1', sandboxProfilePath: '/ext/resources/sandbox.sb' };

const onDarwin = it.runIf(process.platform === 'darwin');
const onLinux = it.runIf(process.platform === 'linux');

describe('planContainment', () => {
  it('wraps nothing when enforcement is switched off, and says so', async () => {
    const plan = await planContainment({ enforce: false, ...SCRATCH });
    expect(plan.kind).toBe('none');
    expect(plan.prefix).toEqual([]);
    expect(plan.warning).toMatch(/enforcement is off/);
  });

  it('degrades with a warning rather than failing on a platform with no sandbox', async () => {
    const plan = await planContainment({ enforce: true, platform: 'win32', ...SCRATCH });
    expect(plan.kind).toBe('none');
    expect(plan.warning).toMatch(/macOS.*Linux/);
  });

  onDarwin('uses seatbelt on macOS, pointed at the shipped profile', async () => {
    const plan = await planContainment({ enforce: true, platform: 'darwin', ...SCRATCH });
    expect(plan.kind).toBe('seatbelt');
    expect(plan.prefix).toEqual([
      '/usr/bin/sandbox-exec',
      '-D',
      'SCRATCH_ROOT=/tmp/bashle/run1',
      '-f',
      '/ext/resources/sandbox.sb',
    ]);
    expect(plan.warning).toBeUndefined();
  });

  onLinux('uses bubblewrap on Linux, configured entirely by argv', async () => {
    const plan = await planContainment({ enforce: true, platform: 'linux', ...SCRATCH });
    if (plan.kind === 'none') {
      expect(plan.warning).toMatch(/bubblewrap|user namespaces/);
      return;
    }
    expect(plan.kind).toBe('bubblewrap');
    expect(plan.prefix[0]).toMatch(/bwrap$/);
    expect(plan.prefix.join(' ')).toContain('--bind /tmp/bashle/run1 /tmp/bashle/run1');
    // A kernel that refuses a network namespace still gets the file sandbox, and says so.
    if (plan.warning) expect(plan.warning).toMatch(/network/);
    else expect(plan.prefix).toContain('--unshare-net');
  });
});

describe('discoverContainment', () => {
  onDarwin('finds seatbelt on macOS', async () => {
    expect(await discoverContainment()).toEqual({ kind: 'seatbelt', path: '/usr/bin/sandbox-exec' });
  });

  onLinux('finds bubblewrap on Linux, or explains why it cannot', async () => {
    const found = await discoverContainment();
    if ('kind' in found) expect(found.kind).toBe('bubblewrap');
    else expect(['not-installed', 'not-usable']).toContain(found.reason);
  });

  it('reports every other platform as unsupported', async () => {
    expect(await discoverContainment('win32')).toEqual({ reason: 'unsupported-platform', platform: 'win32' });
  });
});

describe('describeUnavailable', () => {
  it('tells a Linux user how to install the missing sandbox', () => {
    expect(describeUnavailable({ reason: 'not-installed' })).toMatch(/apt install bubblewrap/);
  });

  it('names sandbox-exec when macOS no longer ships it', () => {
    expect(describeUnavailable({ reason: 'seatbelt-missing' })).toContain('/usr/bin/sandbox-exec');
  });

  it('names user namespaces when bwrap is present but cannot sandbox', () => {
    const message = describeUnavailable({ reason: 'not-usable', path: '/usr/bin/bwrap' });
    expect(message).toContain('/usr/bin/bwrap');
    expect(message).toMatch(/user namespaces/);
  });

  it('always says what is still containing the run', () => {
    for (const unavailable of [
      { reason: 'disabled' },
      { reason: 'not-installed' },
      { reason: 'unsupported-platform', platform: 'win32' },
      { reason: 'not-usable', path: '/usr/bin/bwrap' },
      { reason: 'seatbelt-missing' },
    ] as const) {
      expect(describeUnavailable(unavailable)).toMatch(/scratch clone is containing this run/);
    }
  });
});

describe('buildCommand', () => {
  it('runs bash directly when nothing wraps it', () => {
    expect(buildCommand({ containmentPrefix: [], bashPath: '/bin/bash', entryScript: 'run.sh', argv: ['a'] })).toEqual(
      { command: '/bin/bash', args: ['run.sh', 'a'] },
    );
  });

  it('puts the sandbox in front of bash, keeping the probe arguments last', () => {
    expect(
      buildCommand({
        containmentPrefix: ['/usr/bin/bwrap', '--unshare-net', '--'],
        bashPath: '/usr/bin/bash',
        entryScript: 'run.sh',
        argv: ['staging', '--dry-run'],
      }),
    ).toEqual({
      command: '/usr/bin/bwrap',
      args: ['--unshare-net', '--', '/usr/bin/bash', 'run.sh', 'staging', '--dry-run'],
    });
  });
});
