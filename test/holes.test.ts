import { describe, it, expect } from 'vitest';
import { assembleHoles } from '../src/holes';
import type { FileChange, HoleRecord, LineExecution, Trace } from '../src/types';

const sentinel = (token: string) => `\x01h${token}\x01`;
/** How bash actually reports it: a control character comes back ANSI-C quoted. */
const quotedSentinel = (token: string) => `$'\\001h${token}\\001'`;

const execution = (over: Partial<LineExecution> & { lineNumber: number }): LineExecution => ({
  source: 'demo.sh',
  subshellLevel: 0,
  nestingDepth: 1,
  occurrenceIndex: 0,
  ...over,
});

const record = (over: Partial<HoleRecord> & { token: string }): HoleRecord => ({
  kind: 'net',
  request: 'GET https://api/latest',
  exitCode: 0,
  state: 'open',
  lineNumber: 4,
  occurrenceIndex: 0,
  ...over,
});

const trace = (holeRecords: HoleRecord[], executions: LineExecution[] = []): Trace => ({
  executions,
  holeRecords,
  truncated: false,
});

describe('assembleHoles', () => {
  it('groups repeated calls to one request into a single hole', () => {
    const { holes } = assembleHoles({
      trace: trace([record({ token: '1.1' }), record({ token: '1.2' })]),
      changes: [],
    });

    expect(holes).toHaveLength(1);
    expect(holes[0]!.request).toBe('GET https://api/latest');
  });

  it('numbers holes in the order they were first reached', () => {
    const { holes } = assembleHoles({
      trace: trace([
        record({ token: '1.1', request: 'GET https://api/a' }),
        record({ token: '1.2', request: 'GET https://api/b' }),
        record({ token: '1.3', request: 'GET https://api/a' }),
      ]),
      changes: [],
    });

    expect(holes.map((hole) => [hole.id, hole.request])).toEqual([
      [1, 'GET https://api/a'],
      [2, 'GET https://api/b'],
    ]);
  });

  it('keeps the state the shim reported', () => {
    const { holes } = assembleHoles({
      trace: trace([
        record({ token: '1.1', state: 'filled' }),
        record({ token: '1.2', request: 'hostname', kind: 'cmd', state: 'prefilled' }),
      ]),
      changes: [],
    });

    expect(holes.map((hole) => hole.state)).toEqual(['filled', 'prefilled']);
  });

  it('reads the goal from the use site: a command substitution wants stdout', () => {
    const { holes } = assembleHoles({
      trace: trace(
        [record({ token: '1.1' })],
        [execution({ lineNumber: 4, unexpanded: 'version=$(curl -s "$url")' })],
      ),
      changes: [],
    });

    expect(holes[0]!.goal).toBe('stdout');
  });

  it('reads the goal from the use site: a condition wants only the status', () => {
    const { holes } = assembleHoles({
      trace: trace(
        [record({ token: '1.1' })],
        [execution({ lineNumber: 4, unexpanded: 'if curl -f "$url"; then' })],
      ),
      changes: [],
    });

    expect(holes[0]!.goal).toBe('status');
  });

  it('gives a file hole the goal of contents', () => {
    const { holes } = assembleHoles({
      trace: trace([record({ token: '1.1', kind: 'file', request: 'etc/deploy.conf' })]),
      changes: [],
    });

    expect(holes[0]!.goal).toBe('contents');
  });

  it('reports the variables a hole reached', () => {
    const { holes } = assembleHoles({
      trace: trace(
        [record({ token: '1.1' })],
        [
          execution({ lineNumber: 4, vars: { version: sentinel('1.1') } }),
          execution({ lineNumber: 5, vars: { dest: `releases/${sentinel('1.1')}`, other: 'plain' } }),
        ],
      ),
      changes: [],
    });

    expect(holes[0]!.reaches.variables).toEqual(['version', 'dest']);
  });

  it('reports the lines and created paths a hole reached', () => {
    const changes: FileChange[] = [{ kind: 'created', path: `releases/${sentinel('1.1')}/log` }];
    const { holes } = assembleHoles({
      trace: trace(
        [record({ token: '1.1' })],
        [execution({ lineNumber: 6, expanded: `mkdir -p releases/${sentinel('1.1')}` })],
      ),
      changes,
    });

    expect(holes[0]!.reaches.lineNumbers).toEqual([6]);
    expect(holes[0]!.reaches.createdPaths).toEqual([`releases/${sentinel('1.1')}/log`]);
  });

  it('does not attribute another holes sentinel to this one', () => {
    const { holes } = assembleHoles({
      trace: trace(
        [
          record({ token: '1.1', request: 'GET https://api/a' }),
          record({ token: '2.1', request: 'GET https://api/b' }),
        ],
        [execution({ lineNumber: 5, vars: { a: sentinel('1.1') } })],
      ),
      changes: [],
    });

    expect(holes[0]!.reaches.variables).toEqual(['a']);
    expect(holes[1]!.reaches.variables).toEqual([]);
  });

  it('flags a hole used where a number is required', () => {
    const { diagnostics } = assembleHoles({
      trace: trace(
        [record({ token: '1.1' })],
        [execution({ lineNumber: 7, expanded: `(( ${sentinel('1.1')} > 3 ))` })],
      ),
      changes: [],
    });

    expect(diagnostics).toEqual([{ holeId: 1, lineNumber: 7, kind: 'numeric-context' }]);
  });

  it('does not flag an ordinary string use as numeric', () => {
    const { diagnostics } = assembleHoles({
      trace: trace(
        [record({ token: '1.1' })],
        [execution({ lineNumber: 7, expanded: `echo ${sentinel('1.1')}` })],
      ),
      changes: [],
    });

    expect(diagnostics).toEqual([]);
  });

  it('suggests the directive that would fill the hole', () => {
    const { holes } = assembleHoles({
      trace: trace([
        record({ token: '1.1' }),
        record({ token: '2.1', kind: 'cmd', request: 'docker ps' }),
        record({ token: '3.1', kind: 'file', request: 'etc/deploy.conf' }),
      ]),
      changes: [],
    });

    expect(holes.map((hole) => hole.suggestedFill)).toEqual([
      '# @net GET https://api/latest => ""',
      '# @cmd docker ps => ""',
      '# @file etc/deploy.conf => ""',
    ]);
  });

  describe('the guard against offering a fill next to a bug', () => {
    const emptyDest = () =>
      assembleHoles({
        trace: trace(
          [record({ token: '1.1', kind: 'file', request: '/deploy.conf', lineNumber: 4 })],
          [
            execution({
              lineNumber: 4,
              unexpanded: 'cat "$dest/deploy.conf"',
              expanded: 'cat /deploy.conf',
              vars: { dest: '' },
            }),
          ],
        ),
        changes: [],
      });

    it('marks a hole suspect when the line reached an empty variable', () => {
      expect(emptyDest().holes[0]!.suspect).toEqual({ emptyVariable: 'dest' });
    });

    it('leaves a hole alone when nothing on the line was empty', () => {
      const { holes } = assembleHoles({
        trace: trace(
          [record({ token: '1.1', kind: 'file', request: '/etc/deploy.conf' })],
          [
            execution({
              lineNumber: 4,
              unexpanded: 'cat /etc/deploy.conf',
              vars: { dest: 'releases' },
            }),
          ],
        ),
        changes: [],
      });
      expect(holes[0]!.suspect).toBeUndefined();
    });

    it('ignores an empty variable the line never mentions', () => {
      const { holes } = assembleHoles({
        trace: trace(
          [record({ token: '1.1' })],
          [execution({ lineNumber: 4, unexpanded: 'curl -s https://api/x', vars: { other: '' } })],
        ),
        changes: [],
      });
      expect(holes[0]!.suspect).toBeUndefined();
    });

    it('keeps the suspicion on a hole that was filled, since the bug is still there', () => {
      const { holes } = assembleHoles({
        trace: trace(
          [record({ token: '1.1', kind: 'file', request: '/deploy.conf', state: 'filled' })],
          [
            execution({
              lineNumber: 4,
              unexpanded: 'cat "$dest/deploy.conf"',
              vars: { dest: '' },
            }),
          ],
        ),
        changes: [],
      });
      expect(holes[0]!.state).toBe('filled');
      expect(holes[0]!.suspect).toEqual({ emptyVariable: 'dest' });
    });
  });

  it('finds the sentinel in the ANSI-C quoted form bash actually reports', () => {
    const { holes } = assembleHoles({
      trace: trace(
        [record({ token: '1.1' })],
        [
          execution({ lineNumber: 5, vars: { version: quotedSentinel('1.1') } }),
          execution({ lineNumber: 6, expanded: `mkdir -p ${quotedSentinel('1.1')}` }),
        ],
      ),
      changes: [],
    });

    expect(holes[0]!.reaches.variables).toEqual(['version']);
    expect(holes[0]!.reaches.lineNumbers).toEqual([6]);
  });
});