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

  it('counts repeated executions and shows the last one', () => {
    const executions = [
      execution({ expanded: 'echo one', occurrenceIndex: 0 }),
      execution({ expanded: 'echo two', occurrenceIndex: 1 }),
      execution({ expanded: 'echo three', occurrenceIndex: 2 }),
    ];
    expect(formatInlineAnnotation(executions, 'echo "$n"')).toBe('×3  echo three');
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

describe('formatHoverMarkdown', () => {
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
