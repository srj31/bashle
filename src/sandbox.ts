export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export const BUBBLEWRAP_SEARCH_PATH = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap', 'bwrap'];

export interface SandboxProfileOptions {
  writableRoots: string[];
  allowNetwork?: boolean;
}

const WRITABLE_DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
];

const FORBIDDEN_EXECUTABLES = ['/usr/bin/sudo', '/usr/bin/su', '/usr/bin/chgrp', '/usr/sbin/chown'];

/**
 * Paths bubblewrap masks with /dev/null so they cannot be executed. Linux
 * distributions disagree about which of `/bin` and `/usr/bin` is the real
 * directory, so both spellings are listed; only the ones that exist are used.
 */
export const LINUX_FORBIDDEN_EXECUTABLES = [
  '/usr/bin/sudo',
  '/bin/sudo',
  '/usr/bin/su',
  '/bin/su',
  '/usr/bin/doas',
  '/usr/bin/pkexec',
];

function quoteForProfile(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildSandboxProfile({
  writableRoots,
  allowNetwork = false,
}: SandboxProfileOptions): string {
  const writableSubpaths = writableRoots.map((root) => `    (subpath ${quoteForProfile(root)})`);
  const writableDevices = WRITABLE_DEVICES.map((device) => `    (literal ${quoteForProfile(device)})`);
  const forbiddenExecutables = FORBIDDEN_EXECUTABLES.map(
    (executable) => `    (literal ${quoteForProfile(executable)})`,
  );

  return [
    '(version 1)',
    '(allow default)',
    allowNetwork ? '' : '(deny network*)',
    '(deny process-exec',
    ...forbiddenExecutables,
    ')',
    '(deny file-write*)',
    '(allow file-write*',
    ...writableSubpaths,
    ...writableDevices,
    '    (regex #"^/dev/fd/")',
    ')',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface BubblewrapOptions {
  writableRoots: string[];
  workingDirectory: string;
  allowNetwork?: boolean;
  /** Absolute paths, already known to exist, that are masked with /dev/null. */
  blockedExecutables?: string[];
}

/**
 * The Linux counterpart of the seatbelt profile. Bubblewrap has no profile
 * language: containment is expressed entirely as mount arguments, applied in
 * order, so the read-only root has to come first and the writable roots after
 * it.
 */
export function buildBubblewrapArgs({
  writableRoots,
  workingDirectory,
  allowNetwork = false,
  blockedExecutables = [],
}: BubblewrapOptions): string[] {
  const args = ['--ro-bind', '/', '/'];

  // A fresh /dev gives the script the character devices it needs — null, zero,
  // random, urandom, tty — plus the /dev/fd symlink that process substitution
  // resolves through, which needs a real /proc to point at.
  args.push('--dev', '/dev', '--proc', '/proc');

  for (const root of writableRoots) args.push('--bind', root, root);
  for (const executable of blockedExecutables) args.push('--ro-bind', '/dev/null', executable);

  if (!allowNetwork) args.push('--unshare-net');

  // A PID namespace makes bwrap the init of the run, so killing it on timeout
  // takes every descendant with it rather than leaking orphans.
  args.push('--unshare-pid', '--unshare-uts', '--unshare-ipc', '--die-with-parent', '--new-session');
  args.push('--chdir', workingDirectory);
  args.push('--');

  return args;
}
