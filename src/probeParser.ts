import type { Expectation, Fill, HoleKind, ParsedFile, Probe, ProbeParseError } from './types';
import { unquoteScalar } from './shellWords';

const PROBE_TAG = /^\s*#\s*@probe\b[ \t]?(.*)$/;
const ENV_TAG = /^\s*#\s*@env\b[ \t]*(.*)$/;
const STDIN_TAG = /^\s*#\s*@stdin\b[ \t]*(.*)$/;
const CLOCK_TAG = /^\s*#\s*@clock\b[ \t]*(.*)$/;

/**
 * Fills keyed on a request, all sharing the `<request> => <value>` shape.
 * A fill answers a hole: what a network call, command or file read gives back
 * when the probe runs.
 *
 *   # @net  GET https://api.example.com/latest => "1.4.2"
 *   # @net  GET https://api.example.com/health => exit 22
 *   # @cmd  docker ps => "down" exit 7
 *   # @file etc/deploy.conf => @fixtures/deploy.conf
 *
 * The request is everything before the last unquoted `=>`
 * (splitAtLastUnquotedArrow). parseFillValue then reads the value after it:
 *
 *   "1.4.2"                  → { body: '1.4.2', exitCode: 0 }
 *   exit 22                  → { body: '', exitCode: 22 }
 *   "down" exit 7            → { body: 'down', exitCode: 7 }
 *   @fixtures/deploy.conf    → { body: '', exitCode: 0, fixture: 'fixtures/deploy.conf' }
 *   (no `=>` at all)         → { body: '', exitCode: 0 }
 *
 * A value of `<<EOF` starts a heredoc body instead; see parseRequestFillTag.
 * `# @clock <time>` is the one fill with no request. Its whole text is the
 * body, and its request is ''.
 */
const REQUEST_FILL_TAGS: { kind: HoleKind; pattern: RegExp }[] = [
  { kind: 'net', pattern: /^\s*#\s*@net\b[ \t]*(.*)$/ },
  { kind: 'cmd', pattern: /^\s*#\s*@cmd\b[ \t]*(.*)$/ },
  { kind: 'file', pattern: /^\s*#\s*@file\b[ \t]*(.*)$/ },
];

function matchRequestFill(text: string): { kind: HoleKind; rest: string } | null {
  for (const { kind, pattern } of REQUEST_FILL_TAGS) {
    const matched = pattern.exec(text);
    if (matched) return { kind, rest: matched[1] ?? '' };
  }
  return null;
}
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

/**
 *   staging --dry-run        → { args: 'staging --dry-run' }
 *   "a//b" => "a/b"          → { args: '"a//b"', expectation: '"a/b"' }
 *   "a => b" => exit 0       → { args: '"a => b"', expectation: 'exit 0' }
 *   a => b => c              → { args: 'a => b', expectation: 'c' }
 *   x =>                     → { args: 'x', expectation: '' }
 */
function splitAtLastUnquotedArrow(text: string): { args: string; expectation?: string } {
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
  if (arrowIndex === -1) return { args: text.trim() };
  return {
    args: text.slice(0, arrowIndex).trim(),
    expectation: text.slice(arrowIndex + 2).trim(),
  };
}

/**
 * A fill value is a body, a status, or both. The trailing `exit N` is only
 * recognised at the very end, so a quoted body may contain the word freely.
 */
function parseFillValue(raw: string): { body: string; exitCode: number; fixture?: string } {
  const trimmed = raw.trim();
  const statusOnly = /^exit\s+(-?\d+)$/.exec(trimmed);
  if (statusOnly) return { body: '', exitCode: Number(statusOnly[1]) };

  const bodyThenStatus = /^([\s\S]*?)\s+exit\s+(-?\d+)$/.exec(trimmed);
  const valueText = bodyThenStatus ? bodyThenStatus[1]!.trim() : trimmed;
  const exitCode = bodyThenStatus ? Number(bodyThenStatus[2]) : 0;

  // A bare leading @ names a fixture; quoting it makes it an ordinary body.
  if (valueText.startsWith('@')) return { body: '', exitCode, fixture: valueText.slice(1) };
  return { body: unquoteScalar(valueText), exitCode };
}

function parseExpectation(
  raw: string,
  lineIndex: number,
): { expectation?: Expectation; errors: ProbeParseError[] } {
  if (!raw) {
    return {
      errors: [
        {
          lineIndex,
          message: '`=>` with nothing after it. Use `=> exit N` or `=> "expected stdout"`.',
        },
      ],
    };
  }
  const exitExpectation = /^exit\s+(-?\d+)$/.exec(raw);
  if (exitExpectation) return { expectation: { kind: 'exit', code: Number(exitExpectation[1]) }, errors: [] };
  if (/^exit\b/.test(raw)) {
    return {
      errors: [{ lineIndex, message: `\`${raw}\` is not a valid exit expectation. Use \`=> exit N\`.` }],
    };
  }
  return { expectation: { kind: 'stdout', text: unquoteScalar(raw) }, errors: [] };
}

/** `$name` or `${name` */
const VARIABLE_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/** `name=` or `name+=` at the start of a line, optionally after `local`, `export`, `readonly` or `declare -x` */
const VARIABLE_ASSIGNMENT =
  /^\s*(?:local\s+|export\s+|readonly\s+|declare\s+(?:-\S+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)\+?=/gm;
/** `for name in` */
const FOR_LOOP_VARIABLE = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g;
/** `read name`, skipping any flags before it */
const READ_TARGET = /\bread\s+(?:-\S+\s+)*([A-Za-z_][A-Za-z0-9_]*)/g;

const VARIABLE_NAME_PATTERNS = [VARIABLE_REFERENCE, VARIABLE_ASSIGNMENT, FOR_LOOP_VARIABLE, READ_TARGET];

function collectWatchableVariableNames(source: string): string[] {
  const names = new Set<string>();
  for (const pattern of VARIABLE_NAME_PATTERNS) {
    for (const [, name] of source.matchAll(pattern)) {
      if (name && !BASH_INTERNAL_VARIABLES.has(name) && !name.startsWith('_bashle')) names.add(name);
    }
  }
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

interface BlockTags {
  probeLines: { lineIndex: number; text: string }[];
  env: Record<string, string>;
  fills: Fill[];
  stdin?: string;
  errors: ProbeParseError[];
}

/** One `# @probe`, `# @env`, `# @net`, `# @cmd`, `# @file`, `# @clock` or `# @stdin` comment line, parsed. */
type Tag =
  | { kind: 'probe'; lineIndex: number; text: string }
  | { kind: 'env'; name: string; value: string }
  | { kind: 'fill'; fill: Fill }
  | { kind: 'stdin'; value: string };

/** What one tag made of the line(s) at the cursor. Most take one line; a heredoc takes more. */
interface TagMatch {
  tag?: Tag;
  errors: ProbeParseError[];
  linesConsumed: number;
}

/** Returns null when the line isn't this parser's tag, so the next one can try it. */
type TagParser = (block: string[], offset: number, lineIndex: number) => TagMatch | null;

const single = (tag: Tag): TagMatch => ({ tag, errors: [], linesConsumed: 1 });

/** `<<EOF`, `<<'EOF'` or `<<"EOF"`; group 2 is the terminator. Quotes must match. */
const HEREDOC_OPENER = /^<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1$/;

/** Strips one leading `#` from each line, then the indent they share. */
function dedentHeredoc(lines: string[]): string {
  if (lines.length === 0) return '';
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return `${lines.map((line) => line.slice(common)).join('\n')}\n`;
}

/** Reads body lines from `from` up to the terminator line, which is consumed too. */
function readHeredocBody(
  block: string[],
  from: number,
  terminator: string,
): { bodyLines: string[]; terminated: boolean; linesRead: number } {
  const bodyLines: string[] = [];
  let cursor = from;
  while (cursor < block.length) {
    const line = block[cursor]!.replace(/^[ \t]*#/, '');
    cursor++;
    if (line.trim() === terminator) return { bodyLines, terminated: true, linesRead: cursor - from };
    bodyLines.push(line);
  }
  return { bodyLines, terminated: false, linesRead: cursor - from };
}

const parseProbeTag: TagParser = (block, offset, lineIndex) => {
  const probe = PROBE_TAG.exec(block[offset]!);
  return probe ? single({ kind: 'probe', lineIndex, text: probe[1] ?? '' }) : null;
};

const parseEnvTag: TagParser = (block, offset, lineIndex) => {
  const envTag = ENV_TAG.exec(block[offset]!);
  if (!envTag) return null;
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec((envTag[1] ?? '').trim());
  if (!assignment) {
    return { errors: [{ lineIndex, message: '`@env` needs a KEY=value assignment.' }], linesConsumed: 1 };
  }
  return single({ kind: 'env', name: assignment[1]!, value: unquoteScalar(assignment[2]!.trim()) });
};

/**
 * Reads one `@net`, `@cmd` or `@file` line (see REQUEST_FILL_TAGS for the shape):
 *
 *   1. Match the tag and take the rest of the line.
 *   2. Split it at the last unquoted `=>` into request and value.
 *   3. If the value is a heredoc opener, read the body from the lines below.
 *      Otherwise parse the value on this line with parseFillValue.
 */
const parseRequestFillTag: TagParser = (block, offset, lineIndex) => {
  const requestFill = matchRequestFill(block[offset]!);
  if (!requestFill) return null;
  const { args, expectation } = splitAtLastUnquotedArrow(requestFill.rest);
  const heredoc = HEREDOC_OPENER.exec((expectation ?? '').trim());

  if (!heredoc) {
    return single({
      kind: 'fill',
      fill: { kind: requestFill.kind, request: args, ...parseFillValue(expectation ?? ''), lineIndex },
    });
  }

  // A heredoc body runs on into the comment lines below, so this tag
  // consumes them rather than leaving them to be read as tags:
  //
  //   # @net GET https://api.example.com/v1/status => <<'EOF'
  //   #   {
  //   #     "status": "ok"
  //   #   }
  //   # EOF
  //   # @probe staging
  //
  // The leading `#` of each body line is dropped and the shared indent is
  // stripped, so the fill's body is `{\n  "status": "ok"\n}\n`.
  const terminator = heredoc[2]!;
  const { bodyLines, terminated, linesRead } = readHeredocBody(block, offset + 1, terminator);
  const linesConsumed = 1 + linesRead;

  if (!terminated) {
    return {
      errors: [
        {
          lineIndex,
          message: `Unterminated heredoc: no closing \`${terminator}\` in this comment block.`,
        },
      ],
      linesConsumed,
    };
  }

  return {
    tag: {
      kind: 'fill',
      fill: { kind: requestFill.kind, request: args, body: dedentHeredoc(bodyLines), exitCode: 0, lineIndex },
    },
    errors: [],
    linesConsumed,
  };
};

const parseClockTag: TagParser = (block, offset, lineIndex) => {
  const clockTag = CLOCK_TAG.exec(block[offset]!);
  if (!clockTag) return null;
  return single({
    kind: 'fill',
    fill: { kind: 'clock', request: '', body: (clockTag[1] ?? '').trim(), exitCode: 0, lineIndex },
  });
};

/**
 * `# @stdin yes` is one line of input, newline included, like bash's
 * `<<< yes`. Without the newline `read` stores the value but fails at EOF,
 * which ends a script under `set -e`.
 */
const parseStdinTag: TagParser = (block, offset) => {
  const stdinTag = STDIN_TAG.exec(block[offset]!);
  return stdinTag
    ? single({ kind: 'stdin', value: `${unquoteScalar((stdinTag[1] ?? '').trim())}\n` })
    : null;
};

const TAG_PARSERS: TagParser[] = [
  parseProbeTag,
  parseEnvTag,
  parseRequestFillTag,
  parseClockTag,
  parseStdinTag,
];

/** Tries each parser in turn and takes the first that matches: `p1 <|> p2 <|> …`. */
function firstMatch(block: string[], offset: number, lineIndex: number): TagMatch | null {
  return TAG_PARSERS.reduce<TagMatch | null>(
    (found, parse) => found ?? parse(block, offset, lineIndex),
    null,
  );
}

const EMPTY_BLOCK_TAGS: BlockTags = { probeLines: [], env: {}, fills: [], errors: [] };

/**
 * Combines field by field: lists append, and for `env` and `stdin` the later
 * value wins. With EMPTY_BLOCK_TAGS as the identity this is a monoid, so a
 * block is simply its tags folded together.
 */
function combineBlockTags(earlier: BlockTags, later: BlockTags): BlockTags {
  return {
    probeLines: [...earlier.probeLines, ...later.probeLines],
    env: { ...earlier.env, ...later.env },
    fills: [...earlier.fills, ...later.fills],
    stdin: later.stdin ?? earlier.stdin,
    errors: [...earlier.errors, ...later.errors],
  };
}

/** What one match contributes to its block on its own. */
function blockTagsOf({ tag, errors }: TagMatch): BlockTags {
  const errorsOnly: BlockTags = { ...EMPTY_BLOCK_TAGS, errors };
  if (!tag) return errorsOnly;
  switch (tag.kind) {
    case 'probe':
      return { ...errorsOnly, probeLines: [{ lineIndex: tag.lineIndex, text: tag.text }] };
    case 'env':
      return { ...errorsOnly, env: { [tag.name]: tag.value } };
    case 'stdin':
      return { ...errorsOnly, stdin: tag.value };
    case 'fill':
      return { ...errorsOnly, fills: [tag.fill] };
  }
}

const sameRequest = (a: Fill) => (b: Fill) => a.kind === b.kind && a.request === b.request;

function rejectRepeatFills(tags: BlockTags): BlockTags {
  const isFirst = (fill: Fill, index: number) => tags.fills.findIndex(sameRequest(fill)) === index;
  const repeatErrors = tags.fills
    .filter((fill, index) => !isFirst(fill, index))
    .map((fill) => ({
      lineIndex: fill.lineIndex,
      message: `\`${fill.request || fill.kind}\` already has a fill in this comment block.`,
    }));
  return {
    ...tags,
    fills: tags.fills.filter(isFirst),
    errors: [...tags.errors, ...repeatErrors].sort((a, b) => a.lineIndex - b.lineIndex),
  };
}

/** Yields each tag in the block in order, stepping past however many lines it consumed. */
function* matchTags(block: string[], blockStart: number): Generator<TagMatch> {
  let offset = 0;
  while (offset < block.length) {
    const match = firstMatch(block, offset, blockStart + offset);
    // A line no parser claims is ordinary prose, so it is simply stepped over.
    if (!match) {
      offset++;
      continue;
    }
    yield match;
    offset += match.linesConsumed;
  }
}

function readTags(block: string[], blockStart: number): BlockTags {
  const matches = [...matchTags(block, blockStart)];
  return rejectRepeatFills(matches.map(blockTagsOf).reduce(combineBlockTags, EMPTY_BLOCK_TAGS));
}

function parseBlock(
  lines: string[],
  blockStart: number,
  block: string[],
  end: number,
): { probes: Probe[]; errors: ProbeParseError[] } {
  const { probeLines, env, fills, stdin, errors } = readTags(block, blockStart);
  if (probeLines.length === 0) return { probes: [], errors };

  const targetLineIndex = findNextCodeLineIndex(lines, end);
  if (targetLineIndex === -1) {
    return {
      probes: [],
      errors: [
        ...errors,
        ...probeLines.map(({ lineIndex }) => ({
          lineIndex,
          message: 'Nothing follows this `@probe` for it to run.',
        })),
      ],
    };
  }

  const targetText = lines[targetLineIndex]!;
  const functionName =
    targetLineIndex !== end
      ? undefined
      : FUNCTION_WITH_KEYWORD.exec(targetText)?.[1] ?? FUNCTION_WITH_PARENS.exec(targetText)?.[1];

  const parsed = probeLines.map(({ lineIndex, text }) => {
    const { args, expectation } = splitAtLastUnquotedArrow(text);
    const parsedExpectation = expectation !== undefined ? parseExpectation(expectation, lineIndex) : null;
    const probe: Probe = {
      kind: functionName ? 'function' : 'script',
      ...(functionName ? { target: functionName } : {}),
      argsRaw: args,
      ...(parsedExpectation ? { expectation: parsedExpectation.expectation } : {}),
      env: { ...env },
      fills: fills.map((fill) => ({ ...fill })),
      ...(stdin !== undefined ? { stdin } : {}),
      commentLineIndex: lineIndex,
      targetLineIndex,
    };
    return { probe, errors: parsedExpectation?.errors ?? [] };
  });

  return {
    probes: parsed.map(({ probe }) => probe),
    errors: [...errors, ...parsed.flatMap((p) => p.errors)],
  };
}

export function parseProbes(source: string): ParsedFile {
  const lines = source.split('\n');
  const blocks: { probes: Probe[]; errors: ProbeParseError[] }[] = [];

  let cursor = 0;
  while (cursor < lines.length) {
    if (!COMMENT_LINE.test(lines[cursor]!)) {
      cursor++;
      continue;
    }

    const blockStart = cursor;
    const { block, end } = readCommentBlockAt(lines, blockStart);
    cursor = end;
    blocks.push(parseBlock(lines, blockStart, block, end));
  }

  return {
    probes: blocks.flatMap((b) => b.probes),
    errors: blocks.flatMap((b) => b.errors),
    hasSourceGuard: SOURCE_GUARD.test(source),
    watchableVariableNames: collectWatchableVariableNames(source),
  };
}
