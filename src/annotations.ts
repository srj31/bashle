import type { Hole, LineExecution } from './types';
import { holeLabel, renderHoleSentinels } from './holes';
import { unquoteScalar } from './shellWords';

const MAX_INLINE_COMMAND_LENGTH = 100;
const MAX_INLINE_VARIABLES = 3;
const MAX_INLINE_VALUE_LENGTH = 32;
const MAX_INLINE_SEQUENCE_LENGTH = 80;
const SEPARATOR = '  ';
const VALUE_SEPARATOR = ' · ';

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function commandOf(execution: LineExecution): string {
  return execution.expanded ?? execution.unexpanded ?? '';
}

/** The command as written, where `$name` can still be seen. */
function sourceTextOf(execution: LineExecution): string {
  return execution.unexpanded ?? execution.expanded ?? '';
}

/** A command inside a `$( … )` on its own line is part of that line's run, not a run of its own. */
function isOwnRun(execution: LineExecution): boolean {
  return execution.enclosingLine !== execution.lineNumber;
}

/** `name=` or `name+=`, optionally after `local`, `export`, `readonly` or `declare -x`; `for name in`; `read name` */
const ASSIGNMENTS = [
  /^\s*(?:local\s+|export\s+|readonly\s+|declare\s+(?:-\S+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)\+?=/,
  /^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/,
  /^\s*read\s+(?:-\S+\s+)*([A-Za-z_][A-Za-z0-9_]*)/,
];

function namesAssignedBy(execution: LineExecution): string[] {
  const command = sourceTextOf(execution);
  return ASSIGNMENTS.flatMap((pattern) => pattern.exec(command)?.[1] ?? []);
}

function readsVariable(execution: LineExecution, name: string): boolean {
  return new RegExp(`\\$\\{?${name}\\b`).test(sourceTextOf(execution));
}

/**
 * The value in `name=value` as bash ran it, for when no snapshot came after
 * the command: it was the last one run. `+=` shows only what was appended.
 */
function valueAssignedIn(execution: LineExecution, name: string): string | undefined {
  const assignment = new RegExp(
    `^(?:(?:local|export|readonly|declare(?:\\s+-\\S+)?)\\s+)?${name}=([\\s\\S]*)$`,
  ).exec(execution.expanded ?? '');
  return assignment ? unquoteScalar(assignment[1]!) : undefined;
}

function variableNamesMentionedIn(lineText: string): string[] {
  const names = new Set<string>();
  for (const match of lineText.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]!);
  for (const match of lineText.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm)) names.add(match[1]!);
  for (const match of lineText.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) names.add(match[1]!);
  return [...names];
}

function renderValue(value: string, holes: Hole[]): string {
  const truncated = truncate(renderHoleSentinels(value, holes), MAX_INLINE_VALUE_LENGTH);
  return /\s/.test(truncated) ? `'${truncated}'` : truncated;
}

function relevantVariables(
  execution: LineExecution,
  lineText: string,
  holes: Hole[] = [],
): string[] {
  if (!execution.vars) return [];
  const mentioned = variableNamesMentionedIn(lineText);
  return mentioned
    .filter((name) => execution.vars?.[name] !== undefined)
    .slice(0, MAX_INLINE_VARIABLES)
    .map((name) => `${name}=${renderValue(execution.vars![name]!, holes)}`);
}

interface RepeatedLineVariables {
  names: string[];
  /** Names some run of the line sets; for these only the setting runs count. */
  assigned: Set<string>;
}

function variablesAcrossRuns(runs: LineExecution[], lineText: string): RepeatedLineVariables {
  const assigned = new Set(runs.flatMap(namesAssignedBy));
  return { names: [...new Set([...variableNamesMentionedIn(lineText), ...assigned])], assigned };
}

/**
 * What one run of a repeated line says about a name: the value it set it to,
 * on a line that sets it, or else the value it read. Values are snapshotted
 * before each command, so a value set is only visible in the snapshot after.
 */
function valueIn(run: LineExecution, name: string, { assigned }: RepeatedLineVariables): string | undefined {
  if (assigned.has(name)) {
    if (!namesAssignedBy(run).includes(name)) return undefined;
    return run.varsAfter?.[name] ?? valueAssignedIn(run, name);
  }
  return readsVariable(run, name) ? run.vars?.[name] : undefined;
}

function renderSequence(name: string, values: string[], holes: Hole[]): string {
  let text = `${name}=${renderValue(values[0]!, holes)}`;
  let shown = 1;
  for (; shown < values.length; shown++) {
    const next = `${VALUE_SEPARATOR}${renderValue(values[shown]!, holes)}`;
    if (text.length + next.length > MAX_INLINE_SEQUENCE_LENGTH) break;
    text += next;
  }
  const hidden = values.length - shown;
  return hidden > 0 ? `${text}${VALUE_SEPARATOR}… +${hidden} more` : text;
}

/** Every value each variable took across the runs, in order, repeats included. */
function variableSequences(runs: LineExecution[], lineText: string, holes: Hole[]): string[] {
  const variables = variablesAcrossRuns(runs, lineText);
  return variables.names
    .map((name) => ({
      name,
      values: runs.flatMap((run) => valueIn(run, name, variables) ?? []),
    }))
    .filter(({ values }) => values.length > 0)
    .slice(0, MAX_INLINE_VARIABLES)
    .map(({ name, values }) => renderSequence(name, values, holes));
}

/**
 * A suspect hole leads with what went wrong rather than with the hole, so the
 * fill is never the first thing offered next to an expansion bug.
 */
function renderHoleBadges(holes: Hole[], lineNumber: number): string[] {
  return holes
    .filter((hole) => hole.lineNumber === lineNumber)
    .map((hole) =>
      hole.suspect
        ? `${holeLabel(hole)} $${hole.suspect.emptyVariable} was empty here`
        : holeLabel(hole),
    );
}

export function formatInlineAnnotation(
  executions: LineExecution[],
  lineText: string,
  holes: Hole[] = [],
): string {
  const runs = executions.filter(isOwnRun);
  const last = runs[runs.length - 1];
  if (!last) return '';

  const parts: string[] = [];
  parts.push(truncate(renderHoleSentinels(commandOf(last), holes), MAX_INLINE_COMMAND_LENGTH));
  if (last.exitCode !== undefined && last.exitCode !== 0) parts.push(`✗${last.exitCode}`);
  parts.push(
    ...(runs.length === 1
      ? relevantVariables(last, lineText, holes)
      : variableSequences(runs, lineText, holes)),
  );
  parts.push(...renderHoleBadges(holes, last.lineNumber));

  return parts.filter(Boolean).join(SEPARATOR);
}

function renderExecutionRow(execution: LineExecution, variables: string[], holes: Hole[]): string {
  const status = execution.exitCode === undefined ? '' : ` → exit ${execution.exitCode}`;
  const suffix = variables.length ? `  ${variables.join('  ')}` : '';
  return `\`${renderHoleSentinels(commandOf(execution), holes)}\`${status}${suffix}`;
}

function variablesOfRun(run: LineExecution, variables: RepeatedLineVariables, holes: Hole[]): string[] {
  return variables.names
    .flatMap((name) => {
      const value = valueIn(run, name, variables);
      return value === undefined ? [] : [`${name}=${renderValue(value, holes)}`];
    })
    .slice(0, MAX_INLINE_VARIABLES);
}

/** The Agda goal display: what the hole is for, and what was in scope there. */
function renderHoleGoal(hole: Hole): string[] {
  const scope = Object.entries(hole.context ?? {})
    .map(([name, value]) => `  - \`${name}=${value || "''"}\``)
    .slice(0, 8);
  const heading = hole.suspect
    ? `**${holeLabel(hole)}** — \`$${hole.suspect.emptyVariable}\` was empty here, so this path may not be the one you meant.`
    : `**${holeLabel(hole)}** \`${hole.request}\` · wants ${hole.goal} · ${hole.state}`;
  return [
    heading,
    ...(scope.length ? ['', 'in scope:', ...scope] : []),
    ...(hole.state === 'open' ? ['', `fill: \`${hole.suggestedFill}\``] : []),
  ];
}

export function formatHoverMarkdown(
  executions: LineExecution[],
  lineText: string,
  holes: Hole[] = [],
): string {
  const runs = executions.filter(isOwnRun);
  if (runs.length === 0) return '';

  const lineNumber = runs[0]!.lineNumber;
  const here = holes.filter((hole) => hole.lineNumber === lineNumber);
  const goals = here.flatMap((hole) => ['', ...renderHoleGoal(hole)]);

  if (runs.length === 1) {
    const only = runs[0]!;
    return [renderExecutionRow(only, relevantVariables(only, lineText, holes), holes), ...goals].join('\n');
  }

  const variables = variablesAcrossRuns(runs, lineText);
  const rows = runs.map(
    (run, index) => `${index + 1}. ${renderExecutionRow(run, variablesOfRun(run, variables, holes), holes)}`,
  );
  return [`**${runs.length} executions**`, '', ...rows, ...goals].join('\n');
}

/** Each line's own runs, in order; see isOwnRun. */
export function groupExecutionsByLine(executions: LineExecution[]): Map<number, LineExecution[]> {
  const grouped = new Map<number, LineExecution[]>();
  for (const execution of executions) {
    if (!isOwnRun(execution)) continue;
    const existing = grouped.get(execution.lineNumber);
    if (existing) existing.push(execution);
    else grouped.set(execution.lineNumber, [execution]);
  }
  return grouped;
}
