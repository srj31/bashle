import { describe, it, expect } from 'vitest';
import { evaluateVerdict } from '../src/verdict';

describe('evaluateVerdict', () => {
  it('reports no verdict when the probe stated no expectation', () => {
    expect(evaluateVerdict(undefined, 'anything', 0)).toEqual({ kind: 'none' });
  });

  it('passes a matching exit code', () => {
    expect(evaluateVerdict({ kind: 'exit', code: 1 }, '', 1)).toEqual({ kind: 'pass' });
  });

  it('fails a mismatched exit code and says what it got', () => {
    expect(evaluateVerdict({ kind: 'exit', code: 0 }, '', 3)).toEqual({
      kind: 'fail',
      expected: 'exit 0',
      actual: 'exit 3',
    });
  });

  it('explains a run that was killed before exiting', () => {
    const verdict = evaluateVerdict({ kind: 'exit', code: 0 }, '', null);
    expect(verdict).toMatchObject({ kind: 'fail', actual: 'killed before exiting' });
  });

  it('passes matching stdout', () => {
    expect(evaluateVerdict({ kind: 'stdout', text: 'a/c' }, 'a/c', 0)).toEqual({ kind: 'pass' });
  });

  it('ignores the trailing newline a script almost always prints', () => {
    expect(evaluateVerdict({ kind: 'stdout', text: 'a/c' }, 'a/c\n', 0)).toEqual({ kind: 'pass' });
  });

  it('fails mismatched stdout and reports both sides', () => {
    expect(evaluateVerdict({ kind: 'stdout', text: 'a/c' }, 'a//c\n', 0)).toEqual({
      kind: 'fail',
      expected: 'a/c',
      actual: 'a//c',
    });
  });

  it('does not let a nonzero exit mask a stdout expectation', () => {
    expect(evaluateVerdict({ kind: 'stdout', text: 'x' }, 'x\n', 1)).toEqual({ kind: 'pass' });
  });
});
