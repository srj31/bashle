import type { Expectation, Verdict } from './types';

export function evaluateVerdict(
  expectation: Expectation | undefined,
  stdout: string,
  exitCode: number | null,
): Verdict {
  if (!expectation) return { kind: 'none' };

  if (expectation.kind === 'exit') {
    if (exitCode === expectation.code) return { kind: 'pass' };
    return {
      kind: 'fail',
      expected: `exit ${expectation.code}`,
      actual: exitCode === null ? 'killed before exiting' : `exit ${exitCode}`,
    };
  }

  const actual = stdout.replace(/\n+$/, '');
  const expected = expectation.text.replace(/\n+$/, '');
  if (actual === expected) return { kind: 'pass' };
  return { kind: 'fail', expected, actual };
}
