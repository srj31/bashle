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

/** The text shown after a probe's comment line: empty when the probe has no check. */
export function formatVerdict(verdict: Verdict, durationMs: number): string {
  if (verdict.kind === 'pass') return `✓ passed in ${durationMs} ms`;
  if (verdict.kind === 'fail') return `✗ expected ${verdict.expected} · got ${verdict.actual}`;
  return '';
}
