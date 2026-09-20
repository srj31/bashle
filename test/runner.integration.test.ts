import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProbe } from '../src/runner';
import { parseProbes } from '../src/probeParser';
import { discoverBash } from '../src/bashDiscovery';
import { discoverContainment } from '../src/containment';
import type { RunResult } from '../src/types';

const PRELUDE = resolve(__dirname, '..', 'resources', 'prelude.sh');
const SANDBOX_PROFILE = resolve(__dirname, '..', 'resources', 'sandbox.sb');

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
    sandboxProfilePath: SANDBOX_PROFILE,
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

/**
 * The escape tests are assertions about the kernel sandbox, so on a host
 * without one — a Linux box with no bubblewrap — there is nothing to assert
 * and they say so rather than failing for a missing dependency.
 */
async function kernelSandbox(): Promise<{ enforced: boolean; networkIsolated: boolean }> {
  const containment = await discoverContainment();
  if (!('kind' in containment)) return { enforced: false, networkIsolated: false };
  return { enforced: true, networkIsolated: containment.allowNetwork !== true };
}

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
    expect(result.warnings.join(' ')).not.toMatch(/top-level body ran/);
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

  it('leaves .git out of the scratch clone', async () => {
    mkdirSync(join(workspace, '.git'));
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const result = await runScript(['# @probe', 'ls -a .git || echo "no .git"'].join('\n'));
    expect(result.stdout).toContain('no .git');
  });

  it('reports a modification without modifying the real file', async () => {
    writeFileSync(join(workspace, 'data.txt'), 'one\ntwo\n');
    // Rewrite via a temporary file: `sed -i` takes a suffix on BSD and not on GNU.
    const result = await runScript(
      ['# @probe', "sed 's/two/TWO/' data.txt > edited", 'mv edited data.txt'].join('\n'),
    );
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

  it('blocks a write to an absolute path outside the scratch clone', async (context) => {
    if (!(await kernelSandbox()).enforced) return context.skip();
    const escapeTarget = join('/tmp', `bashle-escape-${process.pid}.txt`);
    const result = await runScript(['# @probe', `echo pwned > ${escapeTarget}`].join('\n'));
    expect(existsSync(escapeTarget)).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('blocks a write back into the real workspace by absolute path', async (context) => {
    if (!(await kernelSandbox()).enforced) return context.skip();
    const result = await runScript(['# @probe', `echo pwned > ${workspace}/escaped.txt`].join('\n'));
    expect(existsSync(join(workspace, 'escaped.txt'))).toBe(false);
  });

  it('blocks the run from reaching the network', async (context) => {
    // Some kernels refuse a network namespace; the run then says so rather than
    // claiming an isolation it does not have, and there is nothing to assert.
    if (!(await kernelSandbox()).networkIsolated) return context.skip();

    const result = await runScript(
      ['# @probe', 'exec 3<>/dev/tcp/1.1.1.1/80 && echo connected'].join('\n'),
      { timeoutMs: 5000 },
    );
    expect(result.stdout).not.toContain('connected');
    expect(result.exitCode).not.toBe(0);
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

describe('probes in a repository subdirectory', () => {
  it('runs with the workspace root as cwd, not the script directory', async () => {
    mkdirSync(join(workspace, 'scripts'));
    writeFileSync(join(workspace, 'data.txt'), 'at repo root\n');
    const scriptPath = join(workspace, 'scripts', 'build.sh');
    const source = ['# @probe', 'cat data.txt'].join('\n');
    writeFileSync(scriptPath, source);
    const parsed = parseProbes(source);

    const result = await runProbe({
      bashPath,
      preludePath: PRELUDE,
      sandboxProfilePath: SANDBOX_PROFILE,
      scriptPath,
      workspaceRoot: workspace,
      probe: parsed.probes[0]!,
      hasSourceGuard: parsed.hasSourceGuard,
      watchVariables: parsed.watchableVariableNames,
      timeoutMs: 10_000,
      maxRecords: 50_000,
      maxCloneBytes: 2e9,
      enforceSandbox: true,
    });

    expect(result.stdout.trim()).toBe('at repo root');
    expect(result.exitCode).toBe(0);
  });

  it('lets a script anchor itself to its own directory the usual way', async () => {
    mkdirSync(join(workspace, 'scripts'));
    writeFileSync(join(workspace, 'scripts', 'data.txt'), 'beside the script\n');
    const scriptPath = join(workspace, 'scripts', 'build.sh');
    const source = ['# @probe', 'cd "$(dirname "$0")"', 'cat data.txt'].join('\n');
    writeFileSync(scriptPath, source);
    const parsed = parseProbes(source);

    const result = await runProbe({
      bashPath,
      preludePath: PRELUDE,
      sandboxProfilePath: SANDBOX_PROFILE,
      scriptPath,
      workspaceRoot: workspace,
      probe: parsed.probes[0]!,
      hasSourceGuard: parsed.hasSourceGuard,
      watchVariables: parsed.watchableVariableNames,
      timeoutMs: 10_000,
      maxRecords: 50_000,
      maxCloneBytes: 2e9,
      enforceSandbox: true,
    });

    expect(result.stdout.trim()).toBe('beside the script');
  });

  it('reports created files relative to the workspace root', async () => {
    mkdirSync(join(workspace, 'scripts'));
    const scriptPath = join(workspace, 'scripts', 'build.sh');
    const source = ['# @probe', 'mkdir -p build', 'echo x > build/out.txt'].join('\n');
    writeFileSync(scriptPath, source);
    const parsed = parseProbes(source);

    const result = await runProbe({
      bashPath,
      preludePath: PRELUDE,
      sandboxProfilePath: SANDBOX_PROFILE,
      scriptPath,
      workspaceRoot: workspace,
      probe: parsed.probes[0]!,
      hasSourceGuard: parsed.hasSourceGuard,
      watchVariables: parsed.watchableVariableNames,
      timeoutMs: 10_000,
      maxRecords: 50_000,
      maxCloneBytes: 2e9,
      enforceSandbox: true,
    });

    expect(result.changes.map((c) => c.path)).toContain('build/out.txt');
  });
});

describe('file fills', () => {
  const readsAConfig = [
    "# @file etc/deploy.conf => <<'EOF'",
    '#   target=staging',
    '# EOF',
    '# @probe',
    'set -euo pipefail',
    'cat etc/deploy.conf',
  ].join('\n');

  it('materializes a @file fill so the script reads a file that genuinely exists', async () => {
    const result = await runScript(readsAConfig);
    expect(result.stdout.trim()).toBe('target=staging');
    expect(result.exitCode).toBe(0);
  });

  it('does not report a materialized fill as a file the run created', async () => {
    const result = await runScript(readsAConfig);
    expect(result.changes.map((change) => change.path)).not.toContain('etc/deploy.conf');
  });

  it('makes a materialized fill reachable by source, by redirection and by [[ -f ]]', async () => {
    const result = await runScript(
      [
        "# @file lib/settings.sh => <<'EOF'",
        '#   TARGET=staging',
        '# EOF',
        '# @probe',
        'set -euo pipefail',
        'source lib/settings.sh',
        'read -r line < lib/settings.sh',
        '[[ -f lib/settings.sh ]] && echo present',
        'echo "$TARGET|$line"',
      ].join('\n'),
    );
    expect(result.stdout).toContain('present');
    expect(result.stdout).toContain('staging|TARGET=staging');
  });

  it('warns rather than silently misplacing an absolute fill path', async () => {
    const result = await runScript(
      ['# @file /etc/deploy.conf => "target=staging"', '# @probe', 'echo done'].join('\n'),
    );
    expect(result.warnings.join('\n')).toMatch(/absolute path/);
  });
});

describe('the watch list must not change what the script does', () => {
  it('sources a file without the watch list turning its exit status into a failure', async () => {
    mkdirSync(join(workspace, 'lib'));
    writeFileSync(join(workspace, 'lib/settings.sh'), 'TARGET=staging\n');
    const result = await runScript(
      ['# @probe', 'set -euo pipefail', 'source lib/settings.sh', 'echo "got $TARGET"'].join('\n'),
    );
    expect(result.stdout.trim()).toBe('got staging');
    expect(result.exitCode).toBe(0);
  });
});

describe('command holes', () => {
  it('fills a network request from a @net directive', async () => {
    const result = await runScript(
      [
        '# @net GET https://api.example.com/v1/latest => "1.4.2"',
        '# @probe',
        'set -euo pipefail',
        'version=$(curl -s https://api.example.com/v1/latest)',
        'echo "version=$version"',
      ].join('\n'),
    );
    expect(result.stdout.trim()).toBe('version=1.4.2');
    expect(result.exitCode).toBe(0);
  });

  it('carries an unfilled request past set -e instead of ending the run', async () => {
    const result = await runScript(
      [
        '# @probe',
        'set -euo pipefail',
        'version=$(curl -s https://api.example.com/v1/latest)',
        'echo "done"',
      ].join('\n'),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');
  });

  it('records an unfilled request as an open hole', async () => {
    const result = await runScript(
      ['# @probe', 'curl -s https://api.example.com/v1/latest || true'].join('\n'),
    );
    expect(result.trace.holeRecords.map((r) => [r.kind, r.request, r.state])).toEqual([
      ['net', 'GET https://api.example.com/v1/latest', 'open'],
    ]);
  });

  it('does not let a sandbox-escaping command reach the real binary', async () => {
    const result = await runScript(
      ['# @cmd docker ps => "nothing running"', '# @probe', 'docker ps'].join('\n'),
    );
    expect(result.stdout.trim()).toBe('nothing running');
  });
});

describe('an unfilled hole propagates', () => {
  it('carries the unknown through variables, commands and the files it creates', async () => {
    const result = await runScript(
      [
        '# @probe',
        'set -euo pipefail',
        'version=$(curl -s https://api.example.com/v1/latest)',
        'dest="releases/$version"',
        'mkdir -p "$dest"',
        'echo ok > "$dest/log"',
      ].join('\n'),
    );

    expect(result.exitCode).toBe(0);
    expect(result.holes).toHaveLength(1);

    const hole = result.holes[0]!;
    expect(hole.request).toBe('GET https://api.example.com/v1/latest');
    expect(hole.state).toBe('open');
    expect(hole.goal).toBe('stdout');
    expect(hole.reaches.variables).toContain('version');
    expect(hole.reaches.variables).toContain('dest');
    expect(hole.reaches.createdPaths.length).toBeGreaterThan(0);
  });

  it('explains a hole used as a number rather than leaving a bare arithmetic error', async () => {
    const result = await runScript(
      [
        '# @probe',
        'count=$(curl -s https://api.example.com/v1/count)',
        'if (( count > 3 )); then echo many; fi',
      ].join('\n'),
    );

    expect(result.holeDiagnostics.map((d) => d.kind)).toContain('numeric-context');
  });

  it('marks a file hole suspect when the path came from an empty variable', async () => {
    const result = await runScript(
      ['# @probe', 'dest=', 'cat "$dest/deploy.conf" || true'].join('\n'),
    );

    expect(result.holes).toHaveLength(1);
    expect(result.holes[0]!.suspect).toEqual({ emptyVariable: 'dest' });
  });
});
