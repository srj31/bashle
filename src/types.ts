export type Expectation =
  | { kind: 'exit'; code: number }
  | { kind: 'stdout'; text: string };

export interface Probe {
  kind: 'script' | 'function';
  target?: string;
  argsRaw: string;
  expectation?: Expectation;
  env: Record<string, string>;
  stdin?: string;
  commentLineIndex: number;
  targetLineIndex: number;
}

export interface ProbeParseError {
  lineIndex: number;
  message: string;
}

export interface ParsedFile {
  probes: Probe[];
  errors: ProbeParseError[];
  hasSourceGuard: boolean;
  watchableVariableNames: string[];
}

export interface LineExecution {
  lineNumber: number;
  source: string;
  subshellLevel: number;
  nestingDepth: number;
  expanded?: string;
  unexpanded?: string;
  exitCode?: number;
  vars?: Record<string, string>;
  occurrenceIndex: number;
}

export interface Trace {
  executions: LineExecution[];
  truncated: boolean;
  finalExit?: number;
}

export interface FileChange {
  kind: 'created' | 'modified' | 'deleted';
  path: string;
  diff?: string;
  binary?: boolean;
  sizeBefore?: number;
  sizeAfter?: number;
}

export type Verdict =
  | { kind: 'pass' }
  | { kind: 'fail'; expected: string; actual: string }
  | { kind: 'none' };

export interface RunResult {
  probe: Probe;
  trace: Trace;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  changes: FileChange[];
  verdict: Verdict;
  sandboxEnforced: boolean;
  durationMs: number;
  warnings: string[];
}
