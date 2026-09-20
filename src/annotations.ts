import type { Hole, LineExecution } from './types';
import { holeLabel, renderHoleSentinels } from './holes';

const MAX_INLINE_COMMAND_LENGTH = 100;
const MAX_INLINE_VARIABLES = 3;
const MAX_INLINE_VALUE_LENGTH = 32;
const SEPARATOR = '  ';

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function commandOf(execution: LineExecution): string {
  return execution.expanded ?? execution.unexpanded ?? '';
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
  const last = executions[executions.length - 1];
  if (!last) return '';

  const parts: string[] = [];
  if (executions.length > 1) parts.push(`×${executions.length}`);
  parts.push(truncate(renderHoleSentinels(commandOf(last), holes), MAX_INLINE_COMMAND_LENGTH));
  if (last.exitCode !== undefined && last.exitCode !== 0) parts.push(`✗${last.exitCode}`);
  parts.push(...relevantVariables(last, lineText, holes));
  parts.push(...renderHoleBadges(holes, last.lineNumber));

  return parts.filter(Boolean).join(SEPARATOR);
}

function renderExecutionRow(execution: LineExecution, lineText: string, holes: Hole[]): string {
  const status = execution.exitCode === undefined ? '' : ` → exit ${execution.exitCode}`;
  const variables = relevantVariables(execution, lineText, holes);
  const suffix = variables.length ? `  ${variables.join('  ')}` : '';
  return `\`${renderHoleSentinels(commandOf(execution), holes)}\`${status}${suffix}`;
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
  if (executions.length === 0) return '';

  const lineNumber = executions[0]!.lineNumber;
  const here = holes.filter((hole) => hole.lineNumber === lineNumber);
  const goals = here.flatMap((hole) => ['', ...renderHoleGoal(hole)]);

  if (executions.length === 1) {
    return [renderExecutionRow(executions[0]!, lineText, holes), ...goals].join('\n');
  }

  const rows = executions.map(
    (execution) =>
      `${execution.occurrenceIndex + 1}. ${renderExecutionRow(execution, lineText, holes)}`,
  );
  return [`**${executions.length} executions**`, '', ...rows, ...goals].join('\n');
}

export function groupExecutionsByLine(executions: LineExecution[]): Map<number, LineExecution[]> {
  const grouped = new Map<number, LineExecution[]>();
  for (const execution of executions) {
    const existing = grouped.get(execution.lineNumber);
    if (existing) existing.push(execution);
    else grouped.set(execution.lineNumber, [execution]);
  }
  return grouped;
}
