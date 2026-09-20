import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Fill } from './types';

export interface MaterializeFileFillsOptions {
  fills: Fill[];
  workspaceRoot: string;
  scratchRoot: string;
}

export interface MaterializeFileFillsResult {
  warnings: string[];
}

/**
 * Where a fill's contents will land, or why they cannot. Only the clone is
 * writable under either sandbox, so a path outside it is refused rather than
 * quietly redirected inside — a script reading `/etc/deploy.conf` would never
 * find a file written to `<clone>/etc/deploy.conf`.
 */
function resolveTarget(scratchRoot: string, request: string): { path: string } | { warning: string } {
  if (isAbsolute(request)) {
    return {
      warning:
        `\`${request}\` is an absolute path, and a fill can only create files inside the ` +
        `sandboxed clone. Use a path relative to the workspace root.`,
    };
  }

  const path = resolve(scratchRoot, request);
  const within = relative(scratchRoot, path);
  if (within.startsWith('..') || isAbsolute(within)) {
    return { warning: `\`${request}\` would be written outside the sandboxed clone.` };
  }
  return { path };
}

async function resolveBody(
  fill: Fill,
  workspaceRoot: string,
): Promise<{ body: string } | { warning: string }> {
  if (fill.fixture === undefined) return { body: fill.body };
  try {
    return { body: await readFile(resolve(workspaceRoot, fill.fixture), 'utf8') };
  } catch {
    return {
      warning: `Fixture \`${fill.fixture}\` for \`${fill.request}\` could not be read.`,
    };
  }
}

/**
 * Writes `@file` fills into the clone before the run starts, so the script
 * reads a file that genuinely exists — which `source`, `<` redirection and
 * `[[ -f ]]` all honour, and no shim could have intercepted.
 */
export async function materializeFileFills({
  fills,
  workspaceRoot,
  scratchRoot,
}: MaterializeFileFillsOptions): Promise<MaterializeFileFillsResult> {
  const warnings: string[] = [];

  for (const fill of fills) {
    if (fill.kind !== 'file') continue;

    const target = resolveTarget(scratchRoot, fill.request);
    if ('warning' in target) {
      warnings.push(target.warning);
      continue;
    }

    const contents = await resolveBody(fill, workspaceRoot);
    if ('warning' in contents) {
      warnings.push(contents.warning);
      continue;
    }

    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, contents.body, 'utf8');
  }

  return { warnings };
}
