import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';

export const IGNORE_FILE_NAME = '.bashleignore';

export const DEFAULT_IGNORE_PATTERNS = ['.git', 'node_modules'];

export interface IgnoreRules {
  ignores(relativePath: string): boolean;
}

export async function loadIgnoreRules(root: string): Promise<IgnoreRules> {
  const rules: Ignore = ignore().add(DEFAULT_IGNORE_PATTERNS);
  try {
    rules.add(await readFile(join(root, IGNORE_FILE_NAME), 'utf8'));
  } catch {
  }
  return rules;
}
