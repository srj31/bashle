import type { LineExecution } from './types';

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

function renderValue(value: string): string {
  const truncated = truncate(value, MAX_INLINE_VALUE_LENGTH);
  return /\s/.test(truncated) ? `'${truncated}'` : truncated;
}

function relevantVariables(execution: LineExecution, lineText: string): string[] {
  if (!execution.vars) return [];
  const mentioned = variableNamesMentionedIn(lineText);
  return mentioned
    .filter((name) => execution.vars?.[name] !== undefined)
    .slice(0, MAX_INLINE_VARIABLES)
    .map((name) => `${name}=${renderValue(execution.vars![name]!)}`);
}

export function formatInlineAnnotation(executions: LineExecution[], lineText: string): string {
  const last = executions[executions.length - 1];
  if (!last) return '';

  const parts: string[] = [];
  if (executions.length > 1) parts.push(`×${executions.length}`);
  parts.push(truncate(commandOf(last), MAX_INLINE_COMMAND_LENGTH));
  if (last.exitCode !== undefined && last.exitCode !== 0) parts.push(`✗${last.exitCode}`);
  parts.push(...relevantVariables(last, lineText));

  return parts.filter(Boolean).join(SEPARATOR);
}

function renderExecutionRow(execution: LineExecution, lineText: string): string {
  const status = execution.exitCode === undefined ? '' : ` → exit ${execution.exitCode}`;
  const variables = relevantVariables(execution, lineText);
  const suffix = variables.length ? `  ${variables.join('  ')}` : '';
  return `\`${commandOf(execution)}\`${status}${suffix}`;
}

export function formatHoverMarkdown(executions: LineExecution[], lineText: string): string {
  if (executions.length === 0) return '';
  if (executions.length === 1) return renderExecutionRow(executions[0]!, lineText);

  const rows = executions.map(
    (execution) => `${execution.occurrenceIndex + 1}. ${renderExecutionRow(execution, lineText)}`,
  );
  return [`**${executions.length} executions**`, '', ...rows].join('\n');
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
