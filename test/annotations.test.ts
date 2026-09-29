import { describe, it, expect } from 'vitest';
import { formatInlineAnnotation, formatHoverMarkdown, groupExecutionsByLine } from '../src/annotations';
import type { Hole, LineExecution } from '../src/types';

const execution = (over: Partial<LineExecution> = {}): LineExecution => ({
  lineNumber: 3,
  source: 'demo.sh',
  subshellLevel: 0,
  nestingDepth: 1,
  occurrenceIndex: 0,
  expanded: 'echo hi',
  exitCode: 0,
  ...over,
});

describe('formatInlineAnnotation', () => {
  it('shows the expanded command for a single successful execution', () => {
    expect(formatInlineAnnotation([execution()], 'echo hi')).toBe('echo hi');
  });

  it('marks a nonzero exit but stays quiet about success', () => {
    expect(formatInlineAnnotation([execution({ expanded: 'false', exitCode: 1 })], 'false')).toBe('false  ✗1');
  });

  it('shows the last run of a repeated line, without counting them', () => {
    const executions = [
      execution({ expanded: 'echo one', occurrenceIndex: 0 }),
      execution({ expanded: 'echo two', occurrenceIndex: 1 }),
      execution({ expanded: 'echo three', occurrenceIndex: 2 }),
    ];
    expect(formatInlineAnnotation(executions, 'echo hi')).toBe('echo three');
  });

  it('appends only the variables the line actually mentions', () => {
    const only = execution({
      expanded: "cp 'a b' /bak/",
      vars: { f: 'a b', dest: '/bak', unrelated: 'noise' },
    });
    expect(formatInlineAnnotation([only], 'cp "$f" "$dest/"')).toBe("cp 'a b' /bak/  f='a b'  dest=/bak");
  });

  it('truncates a very long expansion', () => {
    const long = execution({ expanded: `echo ${'x'.repeat(300)}` });
    const annotation = formatInlineAnnotation([long], 'echo "$x"');
    expect(annotation.length).toBeLessThan(140);
    expect(annotation).toContain('…');
  });

  it('falls back to the unexpanded command when bash reported no expansion', () => {
    const noExpansion = execution({ expanded: undefined, unexpanded: 'read -r line' });
    expect(formatInlineAnnotation([noExpansion], 'read -r line')).toBe('read -r line');
  });

  it('returns nothing when there is nothing to show', () => {
    expect(formatInlineAnnotation([], 'echo hi')).toBe('');
  });
});

describe('formatInlineAnnotation on a line that ran more than once', () => {
  const run = (unexpanded: string, over: Partial<LineExecution> = {}) =>
    execution({ unexpanded, expanded: unexpanded, ...over });

  it('lists every value a variable the line reads had, in order', () => {
    const executions = ['a.txt', 'b.txt', 'c.txt'].map((f, occurrenceIndex) =>
      run('echo "$f"', { expanded: `echo ${f}`, vars: { f }, occurrenceIndex }),
    );
    expect(formatInlineAnnotation(executions, '  echo "$f"')).toBe('echo c.txt  f=a.txt · b.txt · c.txt');
  });

  it('lists the values a loop assigned, as they were after each assignment', () => {
    const header = 'for f in a.txt b.txt c.txt';
    const executions = [
      run(header, { vars: {}, varsAfter: { f: 'a.txt' } }),
      run(header, { vars: { f: 'a.txt' }, varsAfter: { f: 'b.txt' } }),
      run(header, { vars: { f: 'b.txt' }, varsAfter: { f: 'c.txt' } }),
    ];
    expect(formatInlineAnnotation(executions, `${header}; do`)).toBe(`${header}  f=a.txt · b.txt · c.txt`);
  });

  it('shows a value every time it occurred, even when it did not change', () => {
    const executions = ['a', 'a', 'b'].map((f) =>
      run('cp "$f" "$dest/"', { expanded: `cp ${f} /bak/`, vars: { f, dest: '/bak' } }),
    );
    expect(formatInlineAnnotation(executions, 'cp "$f" "$dest/"')).toBe(
      'cp b /bak/  f=a · a · b  dest=/bak · /bak · /bak',
    );
  });

  it("takes a one-line loop's variable only from the command that sets it", () => {
    const executions = [
      run('for i in 1 2', { vars: {}, varsAfter: { i: '1' } }),
      run('echo $i', { expanded: 'echo 1', vars: { i: '1' } }),
      run('for i in 1 2', { vars: { i: '1' }, varsAfter: { i: '2' } }),
      run('echo $i', { expanded: 'echo 2', vars: { i: '2' } }),
    ];
    expect(formatInlineAnnotation(executions, 'for i in 1 2; do echo $i; done')).toBe('echo 2  i=1 · 2');
  });

  it('skips the commands that ran inside a substitution on the same line', () => {
    const executions = [1, 2].flatMap((i) => [
      run('for i in 1 2', { vars: {}, varsAfter: { i: `${i}` } }),
      run('v=$(echo $i)', { expanded: `v=${i}`, vars: { i: `${i}` }, varsAfter: { i: `${i}`, v: `${i}` } }),
      run('echo $i', { expanded: `echo ${i}`, vars: { i: `${i}` }, enclosingLine: 3 }),
    ]);
    expect(formatInlineAnnotation(executions, 'for i in 1 2; do v=$(echo $i); done')).toBe(
      'v=2  i=1 · 2  v=1 · 2',
    );
  });

  it('takes an assigned value from the assignment itself when no snapshot came after it', () => {
    const executions = [
      run('v=$(date)', { expanded: 'v=1', varsAfter: { v: '1' } }),
      run('v=$(date)', { expanded: "v='a b'" }),
    ];
    expect(formatInlineAnnotation(executions, 'v=$(date)')).toBe("v='a b'  v=1 · 'a b'");
  });

  it('stops a long list after about 80 characters and says how many values are left', () => {
    const executions = Array.from({ length: 100 }, (_, index) =>
      run('echo "$i"', { expanded: `echo ${index + 1}`, vars: { i: `${index + 1}` } }),
    );
    expect(formatInlineAnnotation(executions, 'echo "$i"')).toBe(
      'echo 100  i=1 · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9 · 10 · 11 · 12 · 13 · 14 · 15 · 16 · 17 · 18 · … +82 more',
    );
  });
});

describe('formatHoverMarkdown', () => {
  it('numbers the runs and shows each assigned value as it was after that run', () => {
    const header = 'for f in a b';
    const executions = [
      execution({ unexpanded: header, expanded: header, vars: {}, varsAfter: { f: 'a' }, occurrenceIndex: 0 }),
      execution({ unexpanded: header, expanded: header, vars: { f: 'a' }, varsAfter: { f: 'b' }, occurrenceIndex: 2 }),
    ];
    const markdown = formatHoverMarkdown(executions, `${header}; do`);
    expect(markdown).toContain(`1. \`${header}\` → exit 0  f=a`);
    expect(markdown).toContain(`2. \`${header}\` → exit 0  f=b`);
  });

  it('lists every execution of a repeated line', () => {
    const executions = [
      execution({ expanded: 'echo one', occurrenceIndex: 0, vars: { n: 'one' } }),
      execution({ expanded: 'echo two', occurrenceIndex: 1, vars: { n: 'two' }, exitCode: 1 }),
    ];
    const markdown = formatHoverMarkdown(executions, 'echo "$n"');
    expect(markdown).toContain('echo one');
    expect(markdown).toContain('echo two');
    expect(markdown).toContain('2 executions');
  });

  it('describes a single execution without an iteration table', () => {
    const markdown = formatHoverMarkdown([execution()], 'echo hi');
    expect(markdown).not.toContain('executions');
    expect(markdown).toContain('echo hi');
  });

  it('says nothing for a line that never ran', () => {
    expect(formatHoverMarkdown([], 'echo hi')).toBe('');
  });
});

describe('groupExecutionsByLine', () => {
  it('groups executions by their line, preserving order within a line', () => {
    const grouped = groupExecutionsByLine([
      execution({ lineNumber: 3, expanded: 'a' }),
      execution({ lineNumber: 4, expanded: 'b' }),
      execution({ lineNumber: 3, expanded: 'c' }),
    ]);
    expect(grouped.get(3)!.map((e) => e.expanded)).toEqual(['a', 'c']);
    expect(grouped.get(4)!.map((e) => e.expanded)).toEqual(['b']);
  });

  it('returns an empty map for an empty trace', () => {
    expect(groupExecutionsByLine([]).size).toBe(0);
  });

  it("leaves out a command that ran inside a substitution on its own line, but not a function body it ran", () => {
    const grouped = groupExecutionsByLine([
      execution({ lineNumber: 6, expanded: 'w=in-f' }),
      execution({ lineNumber: 6, expanded: 'f', enclosingLine: 6 }),
      execution({ lineNumber: 5, expanded: 'echo in-f', enclosingLine: 6 }),
    ]);
    expect(grouped.get(6)!.map((e) => e.expanded)).toEqual(['w=in-f']);
    expect(grouped.get(5)!.map((e) => e.expanded)).toEqual(['echo in-f']);
  });
});

describe('annotations with holes', () => {
  const hole = (over: Partial<Hole> = {}): Hole => ({
    id: 1,
    kind: 'net',
    request: 'GET https://api/latest',
    state: 'open',
    goal: 'stdout',
    lineNumber: 4,
    tokens: ['1.1'],
    reaches: { variables: [], lineNumbers: [], createdPaths: [] },
    suggestedFill: '# @net GET https://api/latest => ""',
    ...over,
  });

  const line = (over: Partial<LineExecution> = {}): LineExecution => ({
    lineNumber: 4,
    source: 'demo.sh',
    subshellLevel: 0,
    nestingDepth: 1,
    occurrenceIndex: 0,
    ...over,
  });

  it('renders a sentinel in the command as the hole id', () => {
    const text = formatInlineAnnotation(
      [line({ expanded: `mkdir -p $'releases/\\001h1.1\\001'` })],
      'mkdir -p "$dest"',
      [hole()],
    );
    expect(text).toContain('mkdir -p releases/◇1');
  });

  it('renders a sentinel in a variable value as the hole id', () => {
    const text = formatInlineAnnotation(
      [line({ expanded: 'echo', vars: { version: `$'\\001h1.1\\001'` } })],
      'echo "$version"',
      [hole()],
    );
    expect(text).toContain('version=◇1');
  });

  it('badges the line that opened the hole', () => {
    const text = formatInlineAnnotation([line({ expanded: 'curl -s https://api/latest' })], 'x', [
      hole(),
    ]);
    expect(text).toContain('◇1');
  });

  it('leads a suspect hole with the cause rather than the hole', () => {
    const text = formatInlineAnnotation([line({ expanded: 'cat /deploy.conf' })], 'cat "$dest/x"', [
      hole({ kind: 'file', request: '/deploy.conf', suspect: { emptyVariable: 'dest' } }),
    ]);
    expect(text).toContain('◇!1');
    expect(text).toContain('$dest was empty here');
  });

  it('says nothing about holes on a line that opened none', () => {
    const text = formatInlineAnnotation([line({ lineNumber: 9, expanded: 'echo hi' })], 'echo hi', [
      hole(),
    ]);
    expect(text).not.toContain('◇');
  });
});
