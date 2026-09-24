import type { ProbeLens, RunResult, Selection } from './types';

/**
 * The results the editor should draw. Rendering every probe at once stacks one
 * annotation per probe on each shared line, which is what this narrows.
 */
export function visibleResults(results: RunResult[], selection: Selection): RunResult[] {
  if (selection.kind === 'all') return results;
  const chosen = results[selection.index] ?? results[0];
  return chosen ? [chosen] : [];
}

/**
 * A lens per probe comment. Silent below two probes: with one there is nothing
 * to switch to, and with none there has been no run yet.
 */
export function probeLenses(results: RunResult[], selection: Selection): ProbeLens[] {
  if (results.length < 2) return [];
  return results.map((result, index) => ({
    lineIndex: result.probe.commentLineIndex,
    title: titleFor(selection, index),
    command: 'bashle.showProbe',
    args: [nextSelection(selection, index)],
  }));
}

function titleFor(selection: Selection, index: number): string {
  if (selection.kind === 'all') return 'show only this';
  return selection.index === index ? '▶ showing  ·  show all' : 'show';
}

function nextSelection(selection: Selection, index: number): Selection {
  const active = selection.kind === 'one' && selection.index === index;
  return active ? { kind: 'all' } : { kind: 'one', index };
}

/** Keeps a selection pointing at a probe that still exists after a re-run. */
export function clampSelection(selection: Selection, probeCount: number): Selection {
  if (selection.kind === 'all') return selection;
  const inRange = selection.index >= 0 && selection.index < probeCount;
  return inRange ? selection : { kind: 'one', index: 0 };
}
