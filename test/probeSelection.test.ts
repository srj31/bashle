import { describe, it, expect } from 'vitest';
import { visibleResults, probeLenses, clampSelection } from '../src/probeSelection';
import type { Probe, RunResult, Selection } from '../src/types';

const probe = (commentLineIndex: number, argsRaw: string): Probe => ({
  kind: 'script',
  argsRaw,
  env: {},
  fills: [],
  commentLineIndex,
  targetLineIndex: commentLineIndex + 1,
});

const result = (commentLineIndex: number, argsRaw: string): RunResult =>
  ({ probe: probe(commentLineIndex, argsRaw) }) as RunResult;

const staging = result(0, 'staging --dry-run');
const prod = result(1, 'prod');
const both = [staging, prod];

describe('visibleResults', () => {
  it('narrows to the selected probe so annotations stop stacking', () => {
    expect(visibleResults(both, { kind: 'one', index: 1 })).toEqual([prod]);
  });

  it('returns every result when showing all', () => {
    expect(visibleResults(both, { kind: 'all' })).toEqual(both);
  });

  it('falls back to the first probe when the index is out of range', () => {
    expect(visibleResults(both, { kind: 'one', index: 7 })).toEqual([staging]);
  });

  it('returns nothing when there are no results at all', () => {
    expect(visibleResults([], { kind: 'one', index: 0 })).toEqual([]);
  });
});

describe('probeLenses', () => {
  it('marks the active probe and offers the others', () => {
    expect(probeLenses(both, { kind: 'one', index: 0 })).toEqual([
      {
        lineIndex: 0,
        title: '▶ showing  ·  show all',
        command: 'bashle.showProbe',
        args: [{ kind: 'all' }],
      },
      {
        lineIndex: 1,
        title: 'show',
        command: 'bashle.showProbe',
        args: [{ kind: 'one', index: 1 }],
      },
    ]);
  });

  it('offers to narrow to each probe when showing all', () => {
    expect(probeLenses(both, { kind: 'all' }).map((lens) => lens.title)).toEqual([
      'show only this',
      'show only this',
    ]);
  });

  it('places each lens on its own probe comment line', () => {
    const spaced = [result(4, 'a'), result(9, 'b')];
    expect(probeLenses(spaced, { kind: 'all' }).map((lens) => lens.lineIndex)).toEqual([4, 9]);
  });

  it('stays silent when a file has only one probe, since there is nothing to switch to', () => {
    expect(probeLenses([staging], { kind: 'one', index: 0 })).toEqual([]);
  });

  it('stays silent before a run has produced any results', () => {
    expect(probeLenses([], { kind: 'all' })).toEqual([]);
  });
});

describe('clampSelection', () => {
  it('keeps a selection that still points at a probe', () => {
    expect(clampSelection({ kind: 'one', index: 1 }, 2)).toEqual({ kind: 'one', index: 1 });
  });

  it('resets to the first probe when a re-run leaves fewer probes', () => {
    expect(clampSelection({ kind: 'one', index: 3 }, 2)).toEqual({ kind: 'one', index: 0 });
  });

  it('leaves showing-all alone regardless of probe count', () => {
    const all: Selection = { kind: 'all' };
    expect(clampSelection(all, 0)).toEqual(all);
  });
});
