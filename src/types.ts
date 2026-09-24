export type Expectation =
  | { kind: 'exit'; code: number }
  | { kind: 'stdout'; text: string };

export type HoleKind = 'net' | 'cmd' | 'file' | 'clock';

export interface Fill {
  kind: HoleKind;
  request: string;
  body: string;
  /** Set when the value was `=> @path`; the runner reads it and fills in `body`. */
  fixture?: string;
  exitCode: number;
  outputPath?: string;
  lineIndex: number;
}

export interface Probe {
  kind: 'script' | 'function';
  target?: string;
  argsRaw: string;
  expectation?: Expectation;
  env: Record<string, string>;
  fills: Fill[];
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

export interface HoleRecord {
  kind: HoleKind;
  request: string;
  token: string;
  exitCode: number;
  state: 'open' | 'filled' | 'prefilled';
  /** Attributed from the DEBUG record that preceded the shim. */
  lineNumber?: number;
  occurrenceIndex?: number;
}

export interface Trace {
  executions: LineExecution[];
  holeRecords: HoleRecord[];
  truncated: boolean;
  finalExit?: number;
}

export interface HoleReach {
  variables: string[];
  lineNumbers: number[];
  createdPaths: string[];
}

export interface Hole {
  id: number;
  kind: HoleKind;
  request: string;
  state: 'open' | 'filled' | 'prefilled';
  goal: 'stdout' | 'status' | 'contents';
  lineNumber?: number;
  occurrenceIndex?: number;
  /** Variables live at the hole, from the DEBUG snapshot of the owning command. */
  context?: Record<string, string>;
  /** Every shim invocation that answered this request; used to render reach. */
  tokens: string[];
  reaches: HoleReach;
  /** Set when the line reached an empty variable; survives the hole being filled. */
  suspect?: { emptyVariable: string };
  suggestedFill: string;
}

export interface HoleDiagnostic {
  holeId: number;
  lineNumber: number;
  kind: 'numeric-context';
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
  holes: Hole[];
  holeDiagnostics: HoleDiagnostic[];
  sandboxEnforced: boolean;
  durationMs: number;
  warnings: string[];
}

/** Which probe's output the editor is currently showing. */
export type Selection = { kind: 'one'; index: number } | { kind: 'all' };

/** A CodeLens to place on a probe's comment line, as plain data. */
export interface ProbeLens {
  lineIndex: number;
  title: string;
  command: string;
  args: [Selection];
}
