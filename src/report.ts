import { formatInlineAnnotation, formatHoverMarkdown, groupExecutionsByLine } from './annotations';
import { renderHoleSentinels } from './holes';
import type { FileChange, Hole, HoleDiagnostic, ProbeParseError, RunResult, Verdict } from './types';

/**
 * The machine-readable shape an editor consumes. Everything an editor needs is
 * pre-rendered here — annotation text, hover markdown, sentinels resolved to
 * hole ids — so a front end never has to re-derive presentation from the trace.
 */
export const REPORT_VERSION = 1;

export interface ReportAnnotation {
  line: number;
  text: string;
  failed: boolean;
}

export interface ReportHover {
  line: number;
  markdown: string;
}

export interface ReportProbe {
  label: string;
  annotations: ReportAnnotation[];
  hovers: ReportHover[];
  holes: Hole[];
  holeDiagnostics: HoleDiagnostic[];
  changes: FileChange[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  verdict: Verdict;
  warnings: string[];
  sandboxEnforced: boolean;
  durationMs: number;
}

export interface Report {
  version: number;
  script: string;
  probes: ReportProbe[];
  errors: { line: number; message: string }[];
}

export interface BuildReportOptions {
  scriptPath: string;
  source: string;
  results: RunResult[];
  errors: ProbeParseError[];
}

function labelFor(result: RunResult): string {
  if (result.probe.target) return `${result.probe.target} ${result.probe.argsRaw}`.trim();
  return result.probe.argsRaw || '(no arguments)';
}

function probeReport(source: string, result: RunResult): ReportProbe {
  const lines = source.split('\n');
  const byLine = groupExecutionsByLine(result.trace.executions);
  const annotations: ReportAnnotation[] = [];
  const hovers: ReportHover[] = [];

  for (const [line, executions] of [...byLine].sort((a, b) => a[0] - b[0])) {
    const lineText = lines[line - 1] ?? '';
    const text = formatInlineAnnotation(executions, lineText, result.holes);
    if (!text) continue;

    annotations.push({
      line,
      text,
      failed: Boolean(executions[executions.length - 1]?.exitCode),
    });
    hovers.push({ line, markdown: formatHoverMarkdown(executions, lineText, result.holes) });
  }

  const show = (text: string) => renderHoleSentinels(text, result.holes);

  return {
    label: labelFor(result),
    annotations,
    hovers,
    holes: result.holes,
    holeDiagnostics: result.holeDiagnostics,
    changes: result.changes.map((change) => ({ ...change, path: show(change.path) })),
    stdout: show(result.stdout),
    stderr: show(result.stderr),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    verdict: result.verdict,
    warnings: result.warnings,
    sandboxEnforced: result.sandboxEnforced,
    durationMs: result.durationMs,
  };
}

export function buildReport({
  scriptPath,
  source,
  results,
  errors,
}: BuildReportOptions): Report {
  return {
    version: REPORT_VERSION,
    script: scriptPath,
    probes: results.map((result) => probeReport(source, result)),
    errors: errors.map((error) => ({ line: error.lineIndex + 1, message: error.message })),
  };
}
