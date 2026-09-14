import { describe, it, expect } from 'vitest';
import { parseTrace, applyProcessExitCode } from '../src/traceParser';

const RS = '\x1e';
const FS = '\x1f';

const dbg = (line: number, prevExit: number, cmd: string, vars = '', sub = 0) =>
  `${RS}D${FS}s.sh${FS}${line}${FS}${sub}${FS}${FS}${prevExit}${FS}${cmd}${FS}${vars}`;
const xt = (line: number, expanded: string, depth = 1, sub = 0, func = '') =>
  `${RS.repeat(depth)}X${FS}s.sh${FS}${line}${FS}${sub}${FS}${func}${FS}${expanded}\n`;

describe('parseTrace', () => {
  it('pairs a DEBUG record with the xtrace record that follows it', () => {
    const t = parseTrace(dbg(3, 0, 'cp "$f" "$d"') + xt(3, "cp 'a b' '/bak/'"));
    expect(t.executions).toHaveLength(1);
    expect(t.executions[0]!.lineNumber).toBe(3);
    expect(t.executions[0]!.unexpanded).toBe('cp "$f" "$d"');
    expect(t.executions[0]!.expanded).toBe("cp 'a b' '/bak/'");
  });

  it("attributes a command's exit code from the next DEBUG record", () => {
    const t = parseTrace(dbg(1, 0, 'false') + xt(1, 'false') + dbg(2, 1, 'echo') + xt(2, 'echo'));
    expect(t.executions[0]!.exitCode).toBe(1);
  });

  it('closes the final execution using the EXIT record', () => {
    const t = parseTrace(dbg(1, 0, 'false') + xt(1, 'false') + `${RS}E${FS}7`);
    expect(t.executions[0]!.exitCode).toBe(7);
    expect(t.finalExit).toBe(7);
  });

  it('numbers repeated executions of the same line', () => {
    const raw = [dbg(5, 0, 'echo'), xt(5, 'echo 1'), dbg(5, 0, 'echo'), xt(5, 'echo 2'), dbg(5, 0, 'echo'), xt(5, 'echo 3')].join('');
    const t = parseTrace(raw);
    expect(t.executions.map((e) => e.occurrenceIndex)).toEqual([0, 1, 2]);
    expect(t.executions.map((e) => e.expanded)).toEqual(['echo 1', 'echo 2', 'echo 3']);
  });

  it('derives nesting depth from replicated PS4 separators', () => {
    const t = parseTrace(dbg(2, 0, 'x') + xt(2, 'inner', 3));
    expect(t.executions[0]!.nestingDepth).toBe(3);
  });

  it('records the subshell level', () => {
    const t = parseTrace(dbg(4, 0, 'x', '', 2) + xt(4, 'x', 1, 2));
    expect(t.executions[0]!.subshellLevel).toBe(2);
  });

  it("drops the tracer's own frames", () => {
    const t = parseTrace(xt(9, 'printf ...', 1, 0, '_bashle_debug') + dbg(1, 0, 'echo') + xt(1, 'echo'));
    expect(t.executions).toHaveLength(1);
    expect(t.executions[0]!.lineNumber).toBe(1);
  });

  it('parses declare -p output into variable values', () => {
    const vars = 'declare -- dest="/bak"\ndeclare -- f="my report.txt"';
    const t = parseTrace(dbg(3, 0, 'cp', vars) + xt(3, 'cp'));
    expect(t.executions[0]!.vars).toEqual({ dest: '/bak', f: 'my report.txt' });
  });

  it('parses array variables from declare -p', () => {
    const vars = `declare -a items=([0]="a" [1]="b c")`;
    const t = parseTrace(dbg(1, 0, 'x', vars) + xt(1, 'x'));
    expect(t.executions[0]!.vars).toEqual({ items: '(a "b c")' });
  });

  it('survives an xtrace record with no preceding DEBUG record', () => {
    const t = parseTrace(xt(2, 'orphan'));
    expect(t.executions).toHaveLength(1);
    expect(t.executions[0]!.expanded).toBe('orphan');
    expect(t.executions[0]!.unexpanded).toBeUndefined();
  });

  it('flags a truncated trace', () => {
    const t = parseTrace(dbg(1, 0, 'x') + xt(1, 'x') + `${RS}T${FS}50000`);
    expect(t.truncated).toBe(true);
  });

  it('tolerates an empty stream', () => {
    const t = parseTrace('');
    expect(t.executions).toEqual([]);
    expect(t.truncated).toBe(false);
  });

  it('keeps a multi-line expanded command intact', () => {
    const t = parseTrace(dbg(1, 0, 'x') + xt(1, "echo 'a\nb'"));
    expect(t.executions[0]!.expanded).toBe("echo 'a\nb'");
  });
});

describe('parseTrace with real bash orderings', () => {
  it('pairs an xtrace record that bash emits before its DEBUG record', () => {
    const raw = xt(3, 'for f in $files') + dbg(3, 0, 'for f in $files');
    const t = parseTrace(raw);
    expect(t.executions).toHaveLength(1);
    expect(t.executions[0]!.expanded).toBe('for f in $files');
    expect(t.executions[0]!.unexpanded).toBe('for f in $files');
  });

  it('attributes an exit code to the command before the one being announced', () => {
    const raw =
      dbg(2, 0, 'files=x') + xt(2, 'files=x') + xt(3, 'for f in $files') + dbg(3, 7, 'for f in $files');
    const t = parseTrace(raw);
    expect(t.executions[0]!.lineNumber).toBe(2);
    expect(t.executions[0]!.exitCode).toBe(7);
    expect(t.executions[1]!.exitCode).toBeUndefined();
  });

  it('drops the trap invocation bash traces before the tracer runs', () => {
    const raw = xt(3, "_bashle_debug 0 3 demo.sh 'cp a b'", 4) + dbg(3, 0, 'cp a b') + xt(3, 'cp a b');
    const t = parseTrace(raw);
    expect(t.executions).toHaveLength(1);
    expect(t.executions[0]!.expanded).toBe('cp a b');
  });

  it('drops records the prelude emits about itself', () => {
    const preludeRecord = `${RS}D${FS}prelude.sh${FS}40${FS}0${FS}source${FS}0${FS}set -T${FS}`;
    const t = parseTrace(preludeRecord + dbg(1, 0, 'echo') + xt(1, 'echo'), {
      includeSource: (source) => source === 's.sh',
    });
    expect(t.executions).toHaveLength(1);
    expect(t.executions[0]!.source).toBe('s.sh');
  });

  it('still numbers occurrences correctly when pairing arrives out of order', () => {
    const raw = [
      xt(3, 'for f in $files'), dbg(3, 0, 'for'),
      dbg(4, 0, 'cp'), xt(4, 'cp one'),
      xt(3, 'for f in $files'), dbg(3, 0, 'for'),
      dbg(4, 0, 'cp'), xt(4, 'cp two'),
    ].join('');
    const t = parseTrace(raw);
    const line4 = t.executions.filter((e) => e.lineNumber === 4);
    expect(line4.map((e) => e.occurrenceIndex)).toEqual([0, 1]);
    expect(line4.map((e) => e.expanded)).toEqual(['cp one', 'cp two']);
  });
});

describe('applyProcessExitCode', () => {
  it('closes the final execution with the exit code of the process', () => {
    const trace = applyProcessExitCode(parseTrace(dbg(1, 0, 'echo') + xt(1, 'echo')), 3);
    expect(trace.executions[0]!.exitCode).toBe(3);
  });

  it('leaves an already-known exit code alone', () => {
    const raw = dbg(1, 0, 'false') + xt(1, 'false') + dbg(2, 9, 'echo') + xt(2, 'echo');
    const trace = applyProcessExitCode(parseTrace(raw), 0);
    expect(trace.executions[0]!.exitCode).toBe(9);
  });

  it('does nothing when the process was killed without an exit code', () => {
    const trace = applyProcessExitCode(parseTrace(dbg(1, 0, 'x') + xt(1, 'x')), null);
    expect(trace.executions[0]!.exitCode).toBeUndefined();
  });

  it('does nothing for an empty trace', () => {
    expect(applyProcessExitCode(parseTrace(''), 0).executions).toEqual([]);
  });
});
