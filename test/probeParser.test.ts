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
});
