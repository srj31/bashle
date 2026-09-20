import type { HoleKind, HoleRecord, LineExecution, Trace } from './types';

export const RECORD_SEPARATOR = '\x1e';
export const FIELD_SEPARATOR = '\x1f';

const DEBUG_RECORD = 'D';
const XTRACE_RECORD = 'X';
const EXIT_RECORD = 'E';
const TRUNCATION_RECORD = 'T';
const HOLE_RECORD = 'H';

const TRACER_FUNCTION_NAME = '_bashle_debug';

const DECLARE_ENTRY = /^declare\s+(-{1,2}\S*)\s+([A-Za-z_]\w*)(?:=([\s\S]*))?$/;
const ARRAY_ELEMENT = /\[[^\]]*\]="((?:[^"\\]|\\.)*)"/g;
const QUOTED_SCALAR = /^"([\s\S]*)"$|^'([\s\S]*)'$/;

function unquoteDeclaredScalar(raw: string): string {
  const quoted = QUOTED_SCALAR.exec(raw);
  if (!quoted) return raw;
  const wasDoubleQuoted = quoted[1] !== undefined;
  const inner = quoted[1] ?? quoted[2] ?? '';
  return wasDoubleQuoted ? inner.replace(/\\(["\\$`])/g, '$1') : inner;
}

function formatDeclaredArray(raw: string): string {
  const elements = [...raw.matchAll(ARRAY_ELEMENT)].map((m) =>
    (m[1] ?? '').replace(/\\(["\\$`])/g, '$1'),
  );
  const rendered = elements.map((value) => (/\s/.test(value) ? `"${value}"` : value));
  return `(${rendered.join(' ')})`;
}

export function parseDeclareDump(dump: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!dump.trim()) return values;

  for (const entry of dump.split(/\n(?=declare\s)/)) {
    const parsed = DECLARE_ENTRY.exec(entry.trim());
    if (!parsed) continue;
    const [, flags = '', name = '', rawValue] = parsed;
    if (rawValue === undefined) continue;
    const isArray = flags.includes('a') || flags.includes('A');
    values[name] = isArray ? formatDeclaredArray(rawValue) : unquoteDeclaredScalar(rawValue);
  }
  return values;
}

interface RecordWithDepth {
  fields: string[];
  nestingDepth: number;
}

function splitIntoRecords(raw: string): RecordWithDepth[] {
  const chunks = raw.split(RECORD_SEPARATOR);
  if (chunks[0] === '') chunks.shift();

  const records: RecordWithDepth[] = [];
  let replicatedSeparators = 0;

  for (const chunk of chunks) {
    if (chunk === '') {
      replicatedSeparators++;
      continue;
    }
    records.push({
      fields: chunk.split(FIELD_SEPARATOR),
      nestingDepth: replicatedSeparators + 1,
    });
    replicatedSeparators = 0;
  }
  return records;
}

export interface ParseTraceOptions {
  includeSource?: (source: string) => boolean;
}

const TRACER_COMMAND_PREFIX = '_bashle_';

class ExecutionLog {
  private readonly executions: LineExecution[] = [];
  private readonly occurrencesByLine = new Map<string, number>();

  private get last(): LineExecution | undefined {
    return this.executions[this.executions.length - 1];
  }

  /** The execution a shim's hole record belongs to: the one that spawned it. */
  current(): LineExecution | undefined {
    return this.last;
  }

  private lastMatching(source: string, lineNumber: number): LineExecution | undefined {
    const candidate = this.last;
    if (!candidate) return undefined;
    return candidate.source === source && candidate.lineNumber === lineNumber ? candidate : undefined;
  }

  private start(execution: Omit<LineExecution, 'occurrenceIndex'>): LineExecution {
    const key = `${execution.source}:${execution.lineNumber}`;
    const occurrenceIndex = this.occurrencesByLine.get(key) ?? 0;
    this.occurrencesByLine.set(key, occurrenceIndex + 1);
    const started = { ...execution, occurrenceIndex };
    this.executions.push(started);
    return started;
  }

  private attributeExitCodeToCommandBefore(announced: LineExecution, exitCode: number): void {
    const announcedIndex = this.executions.lastIndexOf(announced);
    const preceding = this.executions[announcedIndex - 1];
    if (preceding && preceding.exitCode === undefined) preceding.exitCode = exitCode;
  }

  recordDebug(record: {
    source: string;
    lineNumber: number;
    subshellLevel: number;
    nestingDepth: number;
    unexpanded: string;
    vars: Record<string, string>;
    exitCodeOfPreviousCommand: number;
  }): void {
    const { exitCodeOfPreviousCommand, ...details } = record;
    const alreadyOpen = this.lastMatching(details.source, details.lineNumber);
    const announced =
      alreadyOpen && alreadyOpen.unexpanded === undefined
        ? Object.assign(alreadyOpen, {
            unexpanded: details.unexpanded,
            vars: details.vars,
            subshellLevel: details.subshellLevel,
          })
        : this.start(details);
    this.attributeExitCodeToCommandBefore(announced, exitCodeOfPreviousCommand);
  }

  recordXtrace(record: {
    source: string;
    lineNumber: number;
    subshellLevel: number;
    nestingDepth: number;
    expanded: string;
  }): void {
    const alreadyOpen = this.lastMatching(record.source, record.lineNumber);
    if (alreadyOpen && alreadyOpen.expanded === undefined) {
      alreadyOpen.expanded = record.expanded;
      alreadyOpen.nestingDepth = record.nestingDepth;
      return;
    }
    this.start(record);
  }

  closeWithFinalExit(exitCode: number): void {
    const last = this.last;
    if (last && last.exitCode === undefined) last.exitCode = exitCode;
  }

  all(): LineExecution[] {
    return this.executions;
  }
}

export function parseTrace(raw: string, options: ParseTraceOptions = {}): Trace {
  const includeSource = options.includeSource ?? (() => true);
  const log = new ExecutionLog();
  const holeRecords: HoleRecord[] = [];
  let truncated = false;
  let finalExit: number | undefined;

  for (const { fields, nestingDepth } of splitIntoRecords(raw)) {
    const kind = fields[0];

    if (kind === TRUNCATION_RECORD) {
      truncated = true;
      continue;
    }

    // A shim runs in a child process with no BASH_SOURCE or LINENO of its own,
    // so this is handled before the source filter below would discard it, and
    // is attributed to the command the DEBUG trap announced just beforehand.
    if (kind === HOLE_RECORD) {
      const owner = log.current();
      holeRecords.push({
        kind: (fields[1] ?? 'cmd') as HoleKind,
        request: fields[2] ?? '',
        token: fields[3] ?? '',
        exitCode: Number(fields[4] ?? 0),
        state: (fields[5] ?? 'open') as HoleRecord['state'],
        ...(owner ? { lineNumber: owner.lineNumber, occurrenceIndex: owner.occurrenceIndex } : {}),
      });
      continue;
    }

    if (kind === EXIT_RECORD) {
      finalExit = Number(fields[1] ?? 0);
      log.closeWithFinalExit(finalExit);
      continue;
    }

    const [, source = '', lineText = '0', subshellText = '0', functionName = ''] = fields;
    if (functionName.startsWith(TRACER_COMMAND_PREFIX)) continue;
    if (!includeSource(source)) continue;

    const lineNumber = Number(lineText);
    const subshellLevel = Number(subshellText);

    if (kind === DEBUG_RECORD) {
      const unexpanded = fields[6] ?? '';
      if (unexpanded.startsWith(TRACER_COMMAND_PREFIX)) continue;
      log.recordDebug({
        source,
        lineNumber,
        subshellLevel,
        nestingDepth,
        unexpanded,
        vars: parseDeclareDump(fields[7] ?? ''),
        exitCodeOfPreviousCommand: Number(fields[5] ?? 0),
      });
      continue;
    }

    if (kind === XTRACE_RECORD) {
      const expanded = (fields[5] ?? '').replace(/\n$/, '');
      if (expanded.startsWith(TRACER_COMMAND_PREFIX)) continue;
      log.recordXtrace({ source, lineNumber, subshellLevel, nestingDepth, expanded });
    }
  }

  return {
    executions: log.all(),
    holeRecords,
    truncated,
    ...(finalExit !== undefined ? { finalExit } : {}),
  };
}

export function applyProcessExitCode(trace: Trace, exitCode: number | null): Trace {
  const last = trace.executions[trace.executions.length - 1];
  if (!last || last.exitCode !== undefined || exitCode === null) return trace;
  last.exitCode = exitCode;
  return trace;
}
