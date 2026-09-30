import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/report';
import type { Hole, RunResult } from '../src/types';

const hole = (over: Partial<Hole> = {}): Hole => ({
  id: 1,
  kind: 'net',
  request: 'GET https://api/latest',
  state: 'open',
  goal: 'stdout',
  lineNumber: 2,
  tokens: ['1.1'],
  reaches: { variables: ['version'], lineNumbers: [], createdPaths: [] },
  suggestedFill: '# @net GET https://api/latest => ""',
  ...over,
});

const result = (over: Partial<RunResult> = {}): RunResult => ({
  probe: { kind: 'script', argsRaw: 'staging', env: {}, fills: [], commentLineIndex: 0, targetLineIndex: 1 },
  trace: { executions: [], holeRecords: [], truncated: false },
  stdout: '',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  changes: [],
  verdict: { kind: 'none' },
  holes: [],
  holeDiagnostics: [],
  sandboxEnforced: true,
  durationMs: 12,
  warnings: [],
  ...over,
});

const executed = (lineNumber: number, expanded: string, exitCode = 0) => ({
  lineNumber,
  source: 'demo.sh',
  subshellLevel: 0,
  nestingDepth: 1,
  occurrenceIndex: 0,
  expanded,
  exitCode,
});

describe('buildReport', () => {
  it('emits one annotation per executed line, keyed by line number', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'echo one\necho two',
      results: [result({ trace: { executions: [executed(1, 'echo one')], holeRecords: [], truncated: false } })],
      errors: [],
    });

    expect(report.probes[0]!.annotations).toEqual([
      { line: 1, text: 'echo one', failed: false },
    ]);
  });

  it('marks an annotation failed so the editor can colour it without re-deriving why', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'false',
      results: [result({ trace: { executions: [executed(1, 'false', 1)], holeRecords: [], truncated: false } })],
      errors: [],
    });

    expect(report.probes[0]!.annotations[0]!.failed).toBe(true);
  });

  it('renders a sentinel as the hole id rather than leaking control characters to the editor', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'mkdir -p "$dest"',
      results: [
        result({
          holes: [hole({ lineNumber: 1 })],
          trace: {
            executions: [executed(1, `mkdir -p $'releases/\\001h1.1\\001'`)],
            holeRecords: [],
            truncated: false,
          },
        }),
      ],
      errors: [],
    });

    expect(report.probes[0]!.annotations[0]!.text).toContain('releases/◇1');
    expect(report.probes[0]!.annotations[0]!.text).not.toContain('\x01');
  });

  it('carries a hover per annotated line', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'echo one',
      results: [result({ trace: { executions: [executed(1, 'echo one')], holeRecords: [], truncated: false } })],
      errors: [],
    });

    expect(report.probes[0]!.hovers[0]!.line).toBe(1);
    expect(report.probes[0]!.hovers[0]!.markdown).toContain('echo one');
  });

  it('carries holes, warnings and changes through for the panel', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'x',
      results: [
        result({
          holes: [hole()],
          warnings: ['something degraded'],
          changes: [{ kind: 'created', path: 'releases/log' }],
        }),
      ],
      errors: [],
    });

    const probe = report.probes[0]!;
    expect(probe.holes[0]!.request).toBe('GET https://api/latest');
    expect(probe.warnings).toEqual(['something degraded']);
    expect(probe.changes[0]!.path).toBe('releases/log');
  });

  it('lists holes suspect first, then open, then filled, so an editor need not sort them', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'x',
      results: [
        result({
          holes: [
            hole({ id: 1, state: 'filled' }),
            hole({ id: 2 }),
            hole({ id: 3, suspect: { emptyVariable: 'dest' } }),
            hole({ id: 4, state: 'prefilled' }),
            hole({ id: 5 }),
          ],
        }),
      ],
      errors: [],
    });

    expect(report.probes[0]!.holes.map((h) => h.id)).toEqual([3, 2, 5, 1, 4]);
  });

  it('reports parse errors with one-based lines, as an editor expects', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'x',
      results: [],
      errors: [{ lineIndex: 0, message: '`@env` needs a KEY=value assignment.' }],
    });

    expect(report.errors).toEqual([
      { line: 1, message: '`@env` needs a KEY=value assignment.' },
    ]);
  });

  it('survives a JSON round trip, since that is how the editor receives it', () => {
    const report = buildReport({
      scriptPath: '/w/demo.sh',
      source: 'echo one',
      results: [
        result({
          holes: [hole()],
          trace: { executions: [executed(1, 'echo one')], holeRecords: [], truncated: false },
        }),
      ],
      errors: [],
    });

    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('buildReport verdicts', () => {
  const report = (over: Partial<RunResult>) =>
    buildReport({ scriptPath: '/w/demo.sh', source: '# @probe x\necho x', results: [result(over)], errors: [] }).probes[0]!;

  it('says which line the probe comment is on, so an editor can put the verdict there', () => {
    expect(report({}).line).toBe(1);
  });

  it('renders a failed check the way VS Code shows it', () => {
    const probe = report({ verdict: { kind: 'fail', expected: '"hi"', actual: '"bye"' } });
    expect(probe.verdictText).toBe('✗ expected "hi" · got "bye"');
  });

  it('renders a passing check with its duration', () => {
    expect(report({ verdict: { kind: 'pass' } }).verdictText).toBe('✓ passed in 12 ms');
  });

  it('renders nothing for a probe without a check', () => {
    expect(report({}).verdictText).toBe('');
  });
});
