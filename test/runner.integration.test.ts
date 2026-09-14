import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProbe } from '../src/runner';
import { parseProbes } from '../src/probeParser';
import { discoverBash } from '../src/bashDiscovery';
import type { RunResult } from '../src/types';

const PRELUDE = resolve(__dirname, '..', 'resources', 'prelude.sh');

let bashPath: string;
let workspace: string;

beforeAll(async () => {
  bashPath = (await discoverBash()).path;
});

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'bashle-ws-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

async function runScript(
  source: string,
  overrides: Partial<Parameters<typeof runProbe>[0]> = {},
): Promise<RunResult> {
  const scriptPath = join(workspace, 'demo.sh');
  writeFileSync(scriptPath, source);
  const parsed = parseProbes(source);
  return runProbe({
    bashPath,
    preludePath: PRELUDE,
    scriptPath,
    workspaceRoot: workspace,
    probe: parsed.probes[0]!,
    hasSourceGuard: parsed.hasSourceGuard,
    watchVariables: parsed.watchableVariableNames,
    timeoutMs: 10_000,
    maxRecords: 50_000,
    maxCloneBytes: 2e9,
    enforceSandbox: true,
    ...overrides,
  });
}

const executionsOnLine = (result: RunResult, lineNumber: number) =>
  result.trace.executions.filter((e) => e.lineNumber === lineNumber);

describe('runProbe end to end', () => {
  it('annotates each line with the command bash actually ran', async () => {
    const result = await runScript(['# @probe', 'dest=/backup', 'echo "saving to $dest"'].join('\n'));
    expect(executionsOnLine(result, 2)[0]!.expanded).toBe('dest=/backup');
    expect(executionsOnLine(result, 3)[0]!.expanded).toBe("echo 'saving to /backup'");
    expect(result.stdout.trim()).toBe('saving to /backup');
  });

  it('shows an expansion that reveals an empty variable', async () => {
    const result = await runScript(['# @probe', 'dest=', 'echo "cp file $dest/out"'].join('\n'));
    expect(executionsOnLine(result, 3)[0]!.expanded).toBe("echo 'cp file /out'");
  });

  it('shows word boundaries, so an unquoted split is visible in the expansion', async () => {
    const quoted = await runScript(
      ['# @probe', 'files="my report.txt"', 'cp "$files" dest'].join('\n'),
    );
    expect(executionsOnLine(quoted, 3)[0]!.expanded).toBe("cp 'my report.txt' dest");

    const unquoted = await runScript(
      ['# @probe', 'files="my report.txt"', 'cp $files dest'].join('\n'),
    );
    expect(executionsOnLine(unquoted, 3)[0]!.expanded).toBe('cp my report.txt dest');
  });

  it('reports the exit code of a failing command', async () => {
    const result = await runScript(['# @probe', 'false', 'true'].join('\n'));
    expect(executionsOnLine(result, 2)[0]!.exitCode).toBe(1);
    expect(executionsOnLine(result, 3)[0]!.exitCode).toBe(0);
  });

  it('records one execution per loop iteration with its own expansion', async () => {
    const result = await runScript(
      ['# @probe', 'for name in one two three; do', '  echo "$name"', 'done'].join('\n'),
    );
    const body = executionsOnLine(result, 3);
    expect(body).toHaveLength(3);
    expect(body.map((e) => e.expanded)).toEqual(['echo one', 'echo two', 'echo three']);
    expect(body.map((e) => e.occurrenceIndex)).toEqual([0, 1, 2]);
  });

  it('captures watched variable values as they change', async () => {
    const result = await runScript(
      ['# @probe', 'total=0', 'for n in 1 2; do', '  total=$((total + n))', 'done', 'echo $total'].join('\n'),
    );
    const assignments = executionsOnLine(result, 4);
    expect(assignments.map((e) => e.vars?.total)).toEqual(['0', '1']);
    expect(result.stdout.trim()).toBe('3');
  });

  it('passes a probe whose stdout matches the expectation', async () => {
    const result = await runScript(['# @probe => "hello"', 'echo hello'].join('\n'));
    expect(result.verdict).toEqual({ kind: 'pass' });
  });

  it('fails a probe whose stdout differs and reports both sides', async () => {
    const result = await runScript(['# @probe => "a/b"', 'echo "a//b"'].join('\n'));
    expect(result.verdict).toEqual({ kind: 'fail', expected: 'a/b', actual: 'a//b' });
  });

  it('passes probe arguments through to the script', async () => {
    const result = await runScript(['# @probe staging "two words" => "staging|two words"', 'echo "$1|$2"'].join('\n'));
    expect(result.verdict).toEqual({ kind: 'pass' });
  });

  it('runs a function probe without running the guarded main body', async () => {
    const source = [
      '# @probe 2 3 => "5"',
      'add() {',
      '  echo $(( $1 + $2 ))',
      '}',
      '',
      'if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then',
      '  echo "main ran"',
      'fi',
    ].join('\n');
    const result = await runScript(source);
    expect(result.probe.kind).toBe('function');
    expect(result.verdict).toEqual({ kind: 'pass' });
    expect(result.stdout).not.toContain('main ran');
    expect(result.warnings).toEqual([]);
  });

  it('warns when a function probe had to run an unguarded top-level body', async () => {
    const result = await runScript(
      ['# @probe 1 => "1"', 'identity() {', '  echo "$1"', '}', 'echo "top level ran"'].join('\n'),
    );
    expect(result.warnings.join(' ')).toMatch(/top-level body ran first/);
    expect(result.stdout).toContain('top level ran');
  });
});

describe('runProbe containment', () => {
  it('reports files the script created without touching the real workspace', async () => {
    const result = await runScript(
      ['# @probe', 'mkdir -p out', 'echo hello > out/result.txt'].join('\n'),
    );
    const created = result.changes.find((c) => c.path === 'out/result.txt');
    expect(created?.kind).toBe('created');
    expect(created?.diff).toContain('+hello');
    expect(existsSync(join(workspace, 'out/result.txt'))).toBe(false);
  });

  it('reports a modification without modifying the real file', async () => {
    writeFileSync(join(workspace, 'data.txt'), 'one\ntwo\n');
    const result = await runScript(['# @probe', "sed -i '' 's/two/TWO/' data.txt"].join('\n'));
    const modified = result.changes.find((c) => c.path === 'data.txt');
    expect(modified?.kind).toBe('modified');
    expect(modified?.diff).toContain('+TWO');
    expect(readFileSync(join(workspace, 'data.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('reports a deletion without deleting the real file', async () => {
    writeFileSync(join(workspace, 'doomed.txt'), 'still here\n');
    const result = await runScript(['# @probe', 'rm doomed.txt'].join('\n'));
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'deleted', path: 'doomed.txt' }));
    expect(existsSync(join(workspace, 'doomed.txt'))).toBe(true);
  });

  it('blocks a write to an absolute path outside the scratch clone', async () => {
    const escapeTarget = join('/tmp', `bashle-escape-${process.pid}.txt`);
    const result = await runScript(['# @probe', `echo pwned > ${escapeTarget}`].join('\n'));
    expect(existsSync(escapeTarget)).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('blocks a write back into the real workspace by absolute path', async () => {
    const result = await runScript(['# @probe', `echo pwned > ${workspace}/escaped.txt`].join('\n'));
    expect(existsSync(join(workspace, 'escaped.txt'))).toBe(false);
  });

  it('kills a runaway script and still returns what ran', async () => {
    const result = await runScript(['# @probe', 'echo starting', 'while true; do :; done'].join('\n'), {
      timeoutMs: 2000,
      maxRecords: 2000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('starting');
    expect(result.warnings.join(' ')).toMatch(/Killed after/);
  });
});

describe('supported bash constructs', () => {
  it('traces a while loop body once per iteration', async () => {
    const result = await runScript(
      ['# @probe', 'n=0', 'while (( n < 3 )); do', '  n=$(( n + 1 ))', 'done', 'echo $n'].join('\n'),
    );
    expect(executionsOnLine(result, 4)).toHaveLength(3);
    expect(result.stdout.trim()).toBe('3');
  });

  it('traces only the branch an if statement actually took', async () => {
    const result = await runScript(
      ['# @probe', 'if [[ -n "${MISSING:-}" ]]; then', '  echo taken', 'else', '  echo skipped', 'fi'].join('\n'),
    );
    expect(executionsOnLine(result, 3)).toHaveLength(0);
    expect(executionsOnLine(result, 5)).toHaveLength(1);
  });

  it('traces the matching case arm', async () => {
    const result = await runScript(
      ['# @probe prod', 'case "$1" in', '  staging) echo one ;;', '  prod) echo two ;;', 'esac'].join('\n'),
    );
    expect(executionsOnLine(result, 4)).toHaveLength(1);
    expect(result.stdout.trim()).toBe('two');
  });

  it('follows a call into a function defined in the same script', async () => {
    const result = await runScript(
      ['# @probe', 'greet() {', '  echo "hi $1"', '}', 'greet world'].join('\n'),
    );
    expect(executionsOnLine(result, 3)[0]!.expanded).toBe("echo 'hi world'");
  });

  it('traces a redirection to a file', async () => {
    const result = await runScript(['# @probe', 'echo written > out.txt'].join('\n'));
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'created', path: 'out.txt' }));
  });

  it('reports a pipeline as a single line, which is the known limitation', async () => {
    const result = await runScript(['# @probe', 'echo hello | tr a-z A-Z'].join('\n'));
    expect(result.stdout.trim()).toBe('HELLO');
    const pipelineExecutions = executionsOnLine(result, 2);
    expect(pipelineExecutions.length).toBeGreaterThanOrEqual(1);
    expect(pipelineExecutions.every((e) => e.subshellLevel === 0)).toBe(true);
  });
});
