export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export const BUBBLEWRAP_SEARCH_PATH = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap', 'bwrap'];

export interface SeatbeltOptions {
  profilePath: string;
  /** Must be a real path: seatbelt does not follow symlinks. */
  scratchRoot: string;
}

export const SCRATCH_ROOT_PARAM = 'SCRATCH_ROOT';

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

/** Containment itself lives in `resources/sandbox.sb`; the root goes over as argv, not as profile text. */
export function buildSeatbeltArgs({ profilePath, scratchRoot }: SeatbeltOptions): string[] {
  return ['-D', `${SCRATCH_ROOT_PARAM}=${scratchRoot}`, '-f', profilePath];
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
