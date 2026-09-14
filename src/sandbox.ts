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
