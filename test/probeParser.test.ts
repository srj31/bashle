import { describe, it, expect } from 'vitest';
import { parseProbes } from '../src/probeParser';

describe('parseProbes', () => {
  it('reads a whole-script probe from a top-of-file comment', () => {
    const src = ['#!/usr/bin/env bash', '# @probe staging --dry-run', 'echo hi'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.kind).toBe('script');
    expect(probes[0]!.argsRaw).toBe('staging --dry-run');
    expect(probes[0]!.expectation).toBeUndefined();
  });

  it('binds a probe to the function it sits above', () => {
    const src = ['# @probe "a//b" => "a/b"', 'normalize_path() {', '  echo "$1"', '}'].join('\n');
    const { probes } = parseProbes(src);
    expect(probes[0]!.kind).toBe('function');
    expect(probes[0]!.target).toBe('normalize_path');
    expect(probes[0]!.argsRaw).toBe('"a//b"');
    expect(probes[0]!.expectation).toEqual({ kind: 'stdout', text: 'a/b' });
  });

  it('recognises the `function name` definition form', () => {
    const src = ['# @probe 1', 'function tally {', '  :', '}'].join('\n');
    expect(parseProbes(src).probes[0]!.target).toBe('tally');
  });

  it('parses an exit-code expectation', () => {
    const { probes } = parseProbes('# @probe prod => exit 1\necho');
    expect(probes[0]!.expectation).toEqual({ kind: 'exit', code: 1 });
  });

  it('treats an unquoted expectation as expected stdout', () => {
    const { probes } = parseProbes('# @probe x => hello world\necho');
    expect(probes[0]!.expectation).toEqual({ kind: 'stdout', text: 'hello world' });
  });

  it('does not mistake a => inside the args for an expectation separator', () => {
    const { probes } = parseProbes('# @probe "a => b" => exit 0\necho');
    expect(probes[0]!.argsRaw).toBe('"a => b"');
    expect(probes[0]!.expectation).toEqual({ kind: 'exit', code: 0 });
  });

  it('applies @env and @stdin modifiers to probes in the same comment block', () => {
    const src = ['# @env TOKEN=abc', '# @env MODE=fast', '# @stdin "yes"', '# @probe go', 'echo'].join('\n');
    const p = parseProbes(src).probes[0]!;
    expect(p.env).toEqual({ TOKEN: 'abc', MODE: 'fast' });
    expect(p.stdin).toBe('yes');
  });

  it('keeps separate comment blocks from leaking modifiers into each other', () => {
    const src = ['# @env A=1', '# @probe one', 'echo one', '', '# @probe two', 'echo two'].join('\n');
    const { probes } = parseProbes(src);
    expect(probes[0]!.env).toEqual({ A: '1' });
    expect(probes[1]!.env).toEqual({});
  });

  it('allows several probes on one target', () => {
    const src = ['# @probe a', '# @probe b => exit 2', 'echo'].join('\n');
    expect(parseProbes(src).probes).toHaveLength(2);
  });

  it('reports an error for a probe with no arguments and no target', () => {
    const { errors } = parseProbes('# @probe\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.lineIndex).toBe(0);
  });

  it('reports an error for a malformed @env', () => {
    const { errors } = parseProbes('# @env NOPE\n# @probe x\necho');
    expect(errors[0]!.message).toMatch(/KEY=value/);
  });

  it('detects a source guard', () => {
    const guarded = 'if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi';
    expect(parseProbes(guarded).hasSourceGuard).toBe(true);
    expect(parseProbes('main "$@"').hasSourceGuard).toBe(false);
  });

  it('collects variable names for the watch list without duplicates or specials', () => {
    const src = 'dest=/tmp\nfor f in $files; do\n  cp "$f" "$dest/$1"\ndone';
    const names = parseProbes(src).watchableVariableNames;
    expect(names).toContain('dest');
    expect(names).toContain('files');
    expect(names).toContain('f');
    expect(names).not.toContain('1');
    expect(new Set(names).size).toBe(names.length);
  });

  it('ignores @probe appearing inside a string rather than a comment', () => {
    expect(parseProbes('echo "# @probe fake"').probes).toHaveLength(0);
  });

  it('reads `=> exit N` as a status with an empty body', () => {
    const src = ['# @net GET https://api/health => exit 22', '# @probe go', 'echo'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills[0]).toMatchObject({ request: 'GET https://api/health', body: '', exitCode: 22 });
  });

  it('reads `=> "text" exit N` as both a body and a status', () => {
    const src = ['# @net GET https://api/x => "oops" exit 7', '# @probe go', 'echo'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills[0]).toMatchObject({ body: 'oops', exitCode: 7 });
  });

  it('reads a @cmd fill keyed on the whole argv', () => {
    const src = ['# @cmd docker ps -a => "no containers"', '# @probe go', 'echo'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills[0]).toMatchObject({
      kind: 'cmd',
      request: 'docker ps -a',
      body: 'no containers',
    });
  });

  it('reads a @file fill keyed on the path', () => {
    const src = ['# @file etc/deploy.conf => "target=staging"', '# @probe go', 'echo'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills[0]).toMatchObject({
      kind: 'file',
      request: 'etc/deploy.conf',
      body: 'target=staging',
    });
  });

  it('reads a @clock directive, which pins the clock and takes no arrow', () => {
    const src = ['# @clock 2026-01-15T09:30:00Z', '# @probe go', 'echo'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills[0]).toMatchObject({ kind: 'clock', body: '2026-01-15T09:30:00Z' });
  });

  it('reads `=> @path` as a fixture reference the parser leaves unresolved', () => {
    const src = ['# @net GET https://api/m => @fixtures/manifest.json', '# @probe go', 'echo'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills[0]).toMatchObject({ fixture: 'fixtures/manifest.json', body: '' });
  });

  it('treats a quoted value starting with @ as a literal body, not a fixture', () => {
    const src = ['# @net GET https://api/m => "@literal"', '# @probe go', 'echo'].join('\n');
    const fill = parseProbes(src).probes[0]!.fills[0]!;
    expect(fill.body).toBe('@literal');
    expect(fill.fixture).toBeUndefined();
  });

  it('reads a heredoc body spanning comment lines, dedented', () => {
    const src = [
      "# @file etc/deploy.conf => <<'EOF'",
      '#   target=staging',
      '#   retries=3',
      '# EOF',
      '# @probe go',
      'echo',
    ].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills[0]!.body).toBe('target=staging\nretries=3\n');
  });

  it('keeps a directive that follows a heredoc', () => {
    const src = [
      "# @file a.conf => <<'EOF'",
      '#   one',
      '# EOF',
      '# @net GET https://api/x => "2"',
      '# @probe go',
      'echo',
    ].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills.map((f) => f.kind)).toEqual(['file', 'net']);
  });

  it('reports an unterminated heredoc on the line that opened it', () => {
    const src = ["# @file a.conf => <<'EOF'", '#   one', '# @probe go', 'echo'].join('\n');
    const { errors } = parseProbes(src);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.lineIndex).toBe(0);
    expect(errors[0]!.message).toMatch(/EOF/);
  });

  it('reports a duplicate request rather than letting the last one quietly win', () => {
    const src = [
      '# @net GET https://api/x => "1"',
      '# @net GET https://api/x => "2"',
      '# @probe go',
      'echo',
    ].join('\n');
    const { errors } = parseProbes(src);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.lineIndex).toBe(1);
  });

  it('allows the same request under two different directive kinds', () => {
    const src = ['# @cmd date => "x"', '# @file date => "y"', '# @probe go', 'echo'].join('\n');
    expect(parseProbes(src).errors).toEqual([]);
  });

  it('does not split a request on a => that sits inside quotes', () => {
    const src = ['# @cmd sh -c "a => b" => exit 3', '# @probe go', 'echo'].join('\n');
    const fill = parseProbes(src).probes[0]!.fills[0]!;
    expect(fill.request).toBe('sh -c "a => b"');
    expect(fill.exitCode).toBe(3);
  });

  it('keeps fills scoped to their own comment block', () => {
    const src = [
      '# @net GET https://api/a => "1"',
      '# @probe one',
      'echo one',
      '',
      '# @probe two',
      'echo two',
    ].join('\n');
    const { probes } = parseProbes(src);
    expect(probes[0]!.fills).toHaveLength(1);
    expect(probes[1]!.fills).toEqual([]);
  });
});

describe('parseProbes fills', () => {
  it('reads a @net fill as a stdout body that exits zero', () => {
    const src = ['# @net GET https://api.example.com/v1/latest => "1.4.2"', '# @probe staging', 'echo'].join('\n');
    const { probes, errors } = parseProbes(src);
    expect(errors).toEqual([]);
    expect(probes[0]!.fills).toEqual([
      {
        kind: 'net',
        request: 'GET https://api.example.com/v1/latest',
        body: '1.4.2',
        exitCode: 0,
        lineIndex: 0,
      },
    ]);
  });
});
