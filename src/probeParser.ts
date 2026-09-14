import type { Expectation, ParsedFile, Probe, ProbeParseError } from './types';

const PROBE_DIRECTIVE = /^\s*#\s*@probe\b[ \t]?(.*)$/;
const ENV_DIRECTIVE = /^\s*#\s*@env\b[ \t]*(.*)$/;
const STDIN_DIRECTIVE = /^\s*#\s*@stdin\b[ \t]*(.*)$/;
const COMMENT_LINE = /^\s*#/;
const BLANK_LINE = /^\s*$/;

const FUNCTION_WITH_PARENS = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)/;
const FUNCTION_WITH_KEYWORD = /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|$)/;

const SOURCE_GUARD =
  /BASH_SOURCE\[0\][^\n]*\$(?:0|\{0\})|\$(?:0|\{0\})[^\n]*BASH_SOURCE\[0\]/;

const BASH_INTERNAL_VARIABLES = new Set([
  'IFS', 'PATH', 'HOME', 'PWD', 'OLDPWD', 'SHELL', 'TMPDIR', 'USER', 'LOGNAME',
  'HOSTNAME', 'OSTYPE', 'MACHTYPE', 'LANG', 'TERM', 'PS1', 'PS2', 'PS4',
  'RANDOM', 'SECONDS', 'LINENO', 'FUNCNAME', 'EUID', 'UID', 'PPID', 'SHLVL',
  'BASH', 'BASHOPTS', 'BASHPID', 'BASH_ALIASES', 'BASH_ARGC', 'BASH_ARGV',
  'BASH_COMMAND', 'BASH_ENV', 'BASH_LINENO', 'BASH_SOURCE', 'BASH_SUBSHELL',
  'BASH_VERSION', 'BASH_VERSINFO', 'BASH_XTRACEFD', 'BASH_REMATCH',
]);

const QUOTED_SCALAR = /^"([\s\S]*)"$|^'([\s\S]*)'$/;

function unquoteScalar(raw: string): string {
  const quoted = QUOTED_SCALAR.exec(raw);
  if (!quoted) return raw;
  const wasDoubleQuoted = quoted[1] !== undefined;
  const inner = quoted[1] ?? quoted[2] ?? '';
  return wasDoubleQuoted ? inner.replace(/\\(["\\$`])/g, '$1') : inner;
}

function splitAtLastUnquotedArrow(text: string): { args: string; expectation: string | null } {
  let openQuote: '"' | "'" | null = null;
  let arrowIndex = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (openQuote) {
      if (char === '\\' && openQuote === '"') i++;
      else if (char === openQuote) openQuote = null;
    } else if (char === '"' || char === "'") {
      openQuote = char;
    } else if (char === '=' && text[i + 1] === '>') {
      arrowIndex = i;
      i++;
    }
  }
  if (arrowIndex === -1) return { args: text.trim(), expectation: null };
  return {
    args: text.slice(0, arrowIndex).trim(),
    expectation: text.slice(arrowIndex + 2).trim(),
  };
}

function parseExpectation(
  raw: string,
  lineIndex: number,
  errors: ProbeParseError[],
): Expectation | undefined {
  if (!raw) {
    errors.push({
      lineIndex,
      message: '`=>` with nothing after it. Use `=> exit N` or `=> "expected stdout"`.',
    });
    return undefined;
  }
  const exitExpectation = /^exit\s+(-?\d+)$/.exec(raw);
  if (exitExpectation) return { kind: 'exit', code: Number(exitExpectation[1]) };
  if (/^exit\b/.test(raw)) {
    errors.push({ lineIndex, message: `\`${raw}\` is not a valid exit expectation. Use \`=> exit N\`.` });
    return undefined;
  }
  return { kind: 'stdout', text: unquoteScalar(raw) };
}

function collectWatchableVariableNames(source: string): string[] {
  const names = new Set<string>();
  const remember = (name: string | undefined) => {
    if (name && !BASH_INTERNAL_VARIABLES.has(name) && !name.startsWith('_bashle')) names.add(name);
  };
  for (const m of source.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) remember(m[1]);
  for (const m of source.matchAll(
    /^\s*(?:local\s+|export\s+|readonly\s+|declare\s+(?:-\S+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)\+?=/gm,
  )) remember(m[1]);
  for (const m of source.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) remember(m[1]);
  for (const m of source.matchAll(/\bread\s+(?:-\S+\s+)*([A-Za-z_][A-Za-z0-9_]*)/g)) remember(m[1]);
  return [...names];
}

function findNextCodeLineIndex(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (!BLANK_LINE.test(line) && !COMMENT_LINE.test(line)) return i;
  }
  return -1;
}

function readCommentBlockAt(lines: string[], start: number): { block: string[]; end: number } {
  let end = start;
  while (end < lines.length && COMMENT_LINE.test(lines[end]!)) end++;
  return { block: lines.slice(start, end), end };
}

interface CommentBlockDirectives {
  probeLines: { lineIndex: number; text: string }[];
  env: Record<string, string>;
  stdin?: string;
}

function readDirectives(
  block: string[],
  blockStart: number,
  errors: ProbeParseError[],
): CommentBlockDirectives {
  const probeLines: { lineIndex: number; text: string }[] = [];
  const env: Record<string, string> = {};
  let stdin: string | undefined;

  block.forEach((text, offset) => {
    const lineIndex = blockStart + offset;

    const probe = PROBE_DIRECTIVE.exec(text);
    if (probe) {
      probeLines.push({ lineIndex, text: probe[1] ?? '' });
      return;
    }

    const envDirective = ENV_DIRECTIVE.exec(text);
    if (envDirective) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec((envDirective[1] ?? '').trim());
      if (!assignment) {
        errors.push({ lineIndex, message: '`@env` needs a KEY=value assignment.' });
        return;
      }
      env[assignment[1]!] = unquoteScalar(assignment[2]!.trim());
      return;
    }

    const stdinDirective = STDIN_DIRECTIVE.exec(text);
    if (stdinDirective) stdin = unquoteScalar((stdinDirective[1] ?? '').trim());
  });

  return { probeLines, env, ...(stdin !== undefined ? { stdin } : {}) };
}

export function parseProbes(source: string): ParsedFile {
  const lines = source.split('\n');
  const probes: Probe[] = [];
  const errors: ProbeParseError[] = [];

  let cursor = 0;
  while (cursor < lines.length) {
    if (!COMMENT_LINE.test(lines[cursor]!)) {
      cursor++;
      continue;
    }

    const blockStart = cursor;
    const { block, end } = readCommentBlockAt(lines, blockStart);
    cursor = end;

    const { probeLines, env, stdin } = readDirectives(block, blockStart, errors);
    if (probeLines.length === 0) continue;

    const targetLineIndex = findNextCodeLineIndex(lines, cursor);
    if (targetLineIndex === -1) {
      for (const { lineIndex } of probeLines) {
        errors.push({ lineIndex, message: 'Nothing follows this `@probe` for it to run.' });
      }
      continue;
    }

    const targetText = lines[targetLineIndex]!;
    const functionName =
      FUNCTION_WITH_KEYWORD.exec(targetText)?.[1] ?? FUNCTION_WITH_PARENS.exec(targetText)?.[1];

    for (const { lineIndex, text } of probeLines) {
      const { args, expectation } = splitAtLastUnquotedArrow(text);
      probes.push({
        kind: functionName ? 'function' : 'script',
        ...(functionName ? { target: functionName } : {}),
        argsRaw: args,
        ...(expectation !== null
          ? { expectation: parseExpectation(expectation, lineIndex, errors) }
          : {}),
        env: { ...env },
        ...(stdin !== undefined ? { stdin } : {}),
        commentLineIndex: lineIndex,
        targetLineIndex,
      });
    }
  }

  return {
    probes,
    errors,
    hasSourceGuard: SOURCE_GUARD.test(source),
    watchableVariableNames: collectWatchableVariableNames(source),
  };
}
