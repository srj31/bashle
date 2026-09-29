import type { HoleKind, HoleRecord, LineExecution, Trace } from './types';
import { unescapeDoubleQuoted, unquoteScalar } from './shellWords';

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

function formatDeclaredArray(raw: string): string {
  const elements = [...raw.matchAll(ARRAY_ELEMENT)].map((m) => unescapeDoubleQuoted(m[1] ?? ''));
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
    values[name] = isArray ? formatDeclaredArray(rawValue) : unquoteScalar(rawValue);
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

  /**
   * The execution a record continues. Bash reports a command's expansion only
   * once the substitutions in it have run, so anything that ran in a deeper
   * subshell since, like the `echo` in `x=$(echo hi)`, is stepped over.
   */
  private lastMatching(source: string, lineNumber: number, subshellLevel: number): LineExecution | undefined {
    for (let index = this.executions.length - 1; index >= 0; index--) {
      const candidate = this.executions[index]!;
      if (candidate.subshellLevel > subshellLevel) continue;
      const matches =
        candidate.source === source &&
        candidate.lineNumber === lineNumber &&
        candidate.subshellLevel === subshellLevel;
      return matches ? candidate : undefined;
    }
    return undefined;
  }

  /** Everything after `outer` was stepped over to reach it, so it ran inside `outer`. */
  private enclose(outer: LineExecution): void {
    for (let index = this.executions.length - 1; this.executions[index] !== outer; index--) {
      this.executions[index]!.enclosingLine ??= outer.lineNumber;
    }
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
    for (let index = this.executions.lastIndexOf(announced) - 1; index >= 0; index--) {
      const preceding = this.executions[index]!;
      // What ran inside another command finished before it did; $? is that command's.
      if (preceding.enclosingLine !== undefined) continue;
      // A subshell's first command inherits $? from its parent. If the parent
      // command has not been expanded yet, the subshell is its `$( … )`, and
      // the status is not the parent's: it has not finished.
      const stillRunning =
        preceding.subshellLevel < announced.subshellLevel && preceding.expanded === undefined;
      if (!stillRunning && preceding.exitCode === undefined) preceding.exitCode = exitCode;
      return;
    }
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
    const alreadyOpen = this.lastMatching(details.source, details.lineNumber, details.subshellLevel);
    let announced: LineExecution;
    if (alreadyOpen && alreadyOpen.unexpanded === undefined) {
      announced = Object.assign(alreadyOpen, { unexpanded: details.unexpanded, vars: details.vars });
      this.enclose(announced);
    } else {
      announced = this.start(details);
    }
    this.attributeExitCodeToCommandBefore(announced, exitCodeOfPreviousCommand);
  }

  recordXtrace(record: {
    source: string;
    lineNumber: number;
    subshellLevel: number;
    nestingDepth: number;
    expanded: string;
  }): void {
    const alreadyOpen = this.lastMatching(record.source, record.lineNumber, record.subshellLevel);
    if (alreadyOpen && alreadyOpen.expanded === undefined) {
      alreadyOpen.expanded = record.expanded;
      alreadyOpen.nestingDepth = record.nestingDepth;
      this.enclose(alreadyOpen);
      return;
    }
    this.start(record);
  }

  closeWithFinalExit(exitCode: number): void {
    closeLastCommand(this.executions, exitCode);
  }

  all(): LineExecution[] {
    recordVariablesAfter(this.executions);
    return this.executions;
  }
}

/** The script's status belongs to its last command, not to one that ran inside it. */
function closeLastCommand(executions: LineExecution[], exitCode: number): void {
  for (let index = executions.length - 1; index >= 0; index--) {
    const last = executions[index]!;
    if (last.enclosingLine !== undefined) continue;
    if (last.exitCode === undefined) last.exitCode = exitCode;
    return;
  }
}

/**
 * A command's variables once it had finished are the next snapshot taken in
 * the same shell. One taken in a parent shell comes too late: the command was
 * the last in its subshell, and whatever it set was lost when that exited.
 */
function recordVariablesAfter(executions: LineExecution[]): void {
  // Subshell level → index of the nearest later execution at that level with a snapshot.
  const nextSnapshotAt = new Map<number, number>();
  for (let index = executions.length - 1; index >= 0; index--) {
    const execution = executions[index]!;
    let nearest: number | undefined;
    for (const [level, snapshotIndex] of nextSnapshotAt) {
      if (level <= execution.subshellLevel && (nearest === undefined || snapshotIndex < nearest)) {
        nearest = snapshotIndex;
      }
    }
    const next = nearest === undefined ? undefined : executions[nearest]!;
    if (next && next.subshellLevel === execution.subshellLevel) execution.varsAfter = next.vars;
    if (execution.vars) nextSnapshotAt.set(execution.subshellLevel, index);
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
  if (exitCode !== null) closeLastCommand(trace.executions, exitCode);
  return trace;
}
