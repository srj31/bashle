import type {
  FileChange,
  Hole,
  HoleDiagnostic,
  HoleKind,
  HoleRecord,
  LineExecution,
  Trace,
} from './types';
import { holeSentinelMatcher } from './shims';

export interface AssembleHolesOptions {
  trace: Trace;
  changes: FileChange[];
}

export interface AssembledHoles {
  holes: Hole[];
  diagnostics: HoleDiagnostic[];
}

const DIRECTIVE_BY_KIND: Record<HoleKind, string> = {
  net: '@net',
  cmd: '@cmd',
  file: '@file',
  clock: '@clock',
};

/** A condition only ever looks at the exit status, so a one-word fill is enough there. */
const STATUS_ONLY = /^\s*(?:if|while|until|!)\s|(?:&&|\|\|)/;
const COMMAND_SUBSTITUTION = /\$\(|`/;

/** Contexts where a string cannot stand in for a value, so the hole has to be named. */
const NUMERIC_CONTEXT = /\(\(|\blet\b|-eq\b|-ne\b|-lt\b|-le\b|-gt\b|-ge\b/;

function goalFor(kind: HoleKind, unexpanded: string | undefined): Hole['goal'] {
  if (kind === 'file') return 'contents';
  if (unexpanded && COMMAND_SUBSTITUTION.test(unexpanded)) return 'stdout';
  if (unexpanded && STATUS_ONLY.test(unexpanded)) return 'status';
  return 'stdout';
}

function tokensIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(holeSentinelMatcher())) found.add((match[1] ?? match[2])!);
  return found;
}

/**
 * The one guard against a hole laundering a bug. An empty variable on the line
 * is how bashle's flagship expansion bug looks from here, and offering a fill
 * for it would put a mute button next to the mistake.
 *
 * Deliberately blunt: it does not prove the variable produced the request. It
 * does not need to, because bashle already prints the empty value on that line
 * either way. This only decides whether to lead with the cause or the fill.
 */
function suspectFor(owner: LineExecution | undefined): Hole['suspect'] {
  if (!owner?.unexpanded || !owner.vars) return undefined;
  for (const [name, value] of Object.entries(owner.vars)) {
    if (value !== '') continue;
    if (new RegExp(`\\$\\{?${name}\\b`).test(owner.unexpanded)) return { emptyVariable: name };
  }
  return undefined;
}

function ownerOf(executions: LineExecution[], record: HoleRecord): LineExecution | undefined {
  return executions.find(
    (execution) =>
      execution.lineNumber === record.lineNumber &&
      execution.occurrenceIndex === (record.occurrenceIndex ?? 0),
  );
}

/**
 * Turns the shim's raw records into the holes a reader sees. Two calls to one
 * request are one hole with two occurrences, not two holes, because that is
 * what a single fill would satisfy. Reach is a substring search for the
 * sentinel over values the trace already carries — no dataflow analysis.
 */
export function assembleHoles({ trace, changes }: AssembleHolesOptions): AssembledHoles {
  const byRequest = new Map<string, { hole: Hole; tokens: Set<string> }>();

  for (const record of trace.holeRecords) {
    const identity = `${record.kind}::${record.request}`;
    const existing = byRequest.get(identity);
    if (existing) {
      existing.tokens.add(record.token);
      continue;
    }

    const owner = ownerOf(trace.executions, record);
    byRequest.set(identity, {
      tokens: new Set([record.token]),
      hole: {
        id: byRequest.size + 1,
        kind: record.kind,
        request: record.request,
        state: record.state,
        goal: goalFor(record.kind, owner?.unexpanded),
        ...(record.lineNumber !== undefined ? { lineNumber: record.lineNumber } : {}),
        ...(record.occurrenceIndex !== undefined ? { occurrenceIndex: record.occurrenceIndex } : {}),
        ...(owner?.vars ? { context: owner.vars } : {}),
        ...((): { suspect?: Hole['suspect'] } => {
          const suspect = suspectFor(owner);
          return suspect ? { suspect } : {};
        })(),
        tokens: [],
        reaches: { variables: [], lineNumbers: [], createdPaths: [] },
        suggestedFill: `# ${DIRECTIVE_BY_KIND[record.kind]} ${record.request} => ""`,
      },
    });
  }

  const entries = [...byRequest.values()];
  const diagnostics: HoleDiagnostic[] = [];
  const owning = (token: string) => entries.find((entry) => entry.tokens.has(token));

  for (const execution of trace.executions) {
    for (const [name, value] of Object.entries(execution.vars ?? {})) {
      for (const token of tokensIn(value)) {
        const entry = owning(token);
        if (entry && !entry.hole.reaches.variables.includes(name)) {
          entry.hole.reaches.variables.push(name);
        }
      }
    }

    const expanded = execution.expanded;
    if (expanded === undefined) continue;

    for (const token of tokensIn(expanded)) {
      const entry = owning(token);
      if (!entry) continue;
      if (!entry.hole.reaches.lineNumbers.includes(execution.lineNumber)) {
        entry.hole.reaches.lineNumbers.push(execution.lineNumber);
      }
    }
  }

  // Arithmetic is not word-expanded, so `(( count > 3 ))` traces with the
  // variable's name and never its value: the sentinel has to be found through
  // the variable the line names. Without this the run dies on a bare bash
  // arithmetic error that reads as a bashle bug rather than a fact about the
  // script.
  for (const execution of trace.executions) {
    const text = execution.expanded ?? execution.unexpanded ?? '';
    if (!NUMERIC_CONTEXT.test(text)) continue;

    const reached = tokensIn(text);
    for (const [name, value] of Object.entries(execution.vars ?? {})) {
      if (!new RegExp(`\\b${name}\\b`).test(text)) continue;
      for (const token of tokensIn(value)) reached.add(token);
    }

    for (const token of reached) {
      const entry = owning(token);
      if (!entry) continue;
      const already = diagnostics.some(
        (diagnostic) =>
          diagnostic.holeId === entry.hole.id && diagnostic.lineNumber === execution.lineNumber,
      );
      if (already) continue;
      diagnostics.push({
        holeId: entry.hole.id,
        lineNumber: execution.lineNumber,
        kind: 'numeric-context',
      });
    }
  }

  for (const change of changes) {
    for (const token of tokensIn(change.path)) {
      const entry = owning(token);
      if (entry && !entry.hole.reaches.createdPaths.includes(change.path)) {
        entry.hole.reaches.createdPaths.push(change.path);
      }
    }
  }

  return {
    holes: entries.map((entry) => ({ ...entry.hole, tokens: [...entry.tokens] })),
    diagnostics,
  };
}

/** How a hole reads once a person sees it. */
export const holeLabel = (hole: Hole): string => `${hole.suspect ? '\u25c7!' : '\u25c7'}${hole.id}`;

const ANSI_C_QUOTED = /\$'((?:[^'\\]|\\.)*)'/g;

/**
 * Replaces a sentinel with the hole's display id wherever it surfaces: variable
 * values, expanded commands, the script's own output, and filenames. Bash wraps
 * a control-character value in ANSI-C quoting, so that wrapper is unwrapped too
 * rather than left around a rendered id.
 */
export function renderHoleSentinels(text: string, holes: Hole[]): string {
  const idByToken = new Map<string, number>();
  for (const hole of holes) for (const token of hole.tokens) idByToken.set(token, hole.id);

  const replaceTokens = (value: string): string =>
    value.replace(holeSentinelMatcher(), (whole, raw?: string, escaped?: string) => {
      const id = idByToken.get((raw ?? escaped)!);
      return id === undefined ? whole : `\u25c7${id}`;
    });

  return replaceTokens(
    text.replace(ANSI_C_QUOTED, (whole, inner: string) =>
      holeSentinelMatcher().test(inner) ? replaceTokens(inner) : whole,
    ),
  );
}
