import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseProbes } from './probeParser';
import { discoverBash } from './bashDiscovery';
import { runProbe } from './runner';
import { formatInlineAnnotation, groupExecutionsByLine } from './annotations';
import { holeLabel, renderHoleSentinels } from './holes';
import type { Hole, RunResult } from './types';

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const ANNOTATION_COLUMN = 46;

function padTo(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

function printAnnotatedSource(source: string, result: RunResult): void {
  const byLine = groupExecutionsByLine(result.trace.executions);
  const lines = source.split('\n');

  lines.forEach((lineText, index) => {
    const executions = byLine.get(index + 1) ?? [];
    const annotation = formatInlineAnnotation(executions, lineText, result.holes);
    const failed = executions[executions.length - 1]?.exitCode;
    const gutter = `${DIM}${String(index + 1).padStart(3)}${RESET} `;

    if (!annotation) {
      console.log(`${gutter}${lineText}`);
      return;
    }
    const color = failed ? RED : DIM;
    console.log(`${gutter}${padTo(lineText, ANNOTATION_COLUMN)}${color}${annotation}${RESET}`);
  });
}

/**
 * Open holes come first because they are the ones still to answer, and a
 * suspect hole leads with its cause so the fill is never the easiest thing to
 * reach for next to a bug.
 */
function printHoles(result: RunResult): void {
  const open = result.holes.filter((hole) => hole.state === 'open');
  if (result.holes.length === 0) return;

  const ordered = [...result.holes].sort((a, b) => {
    const rank = (hole: Hole) => (hole.suspect ? 0 : hole.state === 'open' ? 1 : 2);
    return rank(a) - rank(b) || a.id - b.id;
  });

  console.log(`\n${DIM}holes${RESET} ${DIM}(${open.length} open)${RESET}`);
  for (const hole of ordered) {
    const where = hole.lineNumber === undefined ? '' : ` ${DIM}line ${hole.lineNumber}${RESET}`;
    const colour = hole.suspect ? YELLOW : hole.state === 'open' ? CYAN : DIM;
    console.log(`  ${colour}${holeLabel(hole)}${RESET} ${hole.request}${where}`);

    if (hole.suspect) {
      console.log(`      ${YELLOW}$${hole.suspect.emptyVariable} was empty here${RESET}`);
      continue;
    }
    if (hole.state !== 'open') {
      console.log(`      ${DIM}${hole.state}${RESET}`);
      continue;
    }

    const reach = [
      hole.reaches.variables.length ? `${hole.reaches.variables.join(', ')}` : '',
      hole.reaches.createdPaths.length ? `${hole.reaches.createdPaths.length} file(s)` : '',
    ].filter(Boolean);
    console.log(`      ${DIM}wants ${hole.goal}${reach.length ? ` · reaches ${reach.join(' · ')}` : ''}${RESET}`);
    console.log(`      ${DIM}fill:${RESET} ${hole.suggestedFill}`);
  }

  for (const diagnostic of result.holeDiagnostics) {
    console.log(
      `  ${YELLOW}◇${diagnostic.holeId} was used as a number on line ${diagnostic.lineNumber}${RESET}`,
    );
  }
}

function printResult(source: string, result: RunResult): void {
  const label = result.probe.target
    ? `${result.probe.target} ${result.probe.argsRaw}`
    : result.probe.argsRaw || '(no arguments)';
  console.log(`\n${BOLD}${CYAN}▶ probe: ${label}${RESET}`);

  printAnnotatedSource(source, result);

  if (result.verdict.kind === 'pass') {
    console.log(`\n${GREEN}✓ expectation met${RESET} ${DIM}(${result.durationMs} ms)${RESET}`);
  } else if (result.verdict.kind === 'fail') {
    console.log(
      `\n${RED}✗ expected ${result.verdict.expected} · got ${result.verdict.actual}${RESET}`,
    );
  }

  const show = (text: string) => renderHoleSentinels(text, result.holes);
  if (result.stdout.trim()) console.log(`\n${DIM}stdout${RESET}\n${show(result.stdout.trimEnd())}`);
  if (result.stderr.trim()) console.log(`\n${DIM}stderr${RESET}\n${RED}${show(result.stderr.trimEnd())}${RESET}`);

  printHoles(result);

  console.log(`\n${DIM}files changed in the sandbox${RESET}`);
  if (result.changes.length === 0) {
    console.log(`${DIM}  none${RESET}`);
  } else {
    for (const change of result.changes) {
      const mark = change.kind === 'created' ? '+' : change.kind === 'deleted' ? '-' : '~';
      const color = change.kind === 'deleted' ? RED : GREEN;
      console.log(`  ${color}${mark} ${show(change.path)}${RESET}`);
    }
  }

  for (const warning of result.warnings) console.log(`${YELLOW}⚠ ${warning}${RESET}`);
  const containment = result.sandboxEnforced ? `${GREEN}⛨ sandboxed${RESET}` : `${YELLOW}⚠ not enforced${RESET}`;
  console.log(`${DIM}exit ${result.exitCode} ·${RESET} ${containment}`);
}

async function main(): Promise<number> {
  const scriptArgument = process.argv[2];
  if (!scriptArgument) {
    console.error('usage: npm run probe -- <script.sh>');
    return 2;
  }

  const scriptPath = resolve(scriptArgument);
  const source = await readFile(scriptPath, 'utf8');
  const parsed = parseProbes(source);

  for (const error of parsed.errors) {
    console.error(`${RED}line ${error.lineIndex + 1}: ${error.message}${RESET}`);
  }
  if (parsed.probes.length === 0) {
    console.error(`No ${BOLD}# @probe${RESET} comments found in ${scriptPath}.`);
    return 1;
  }

  const bash = await discoverBash();
  console.log(`${DIM}using ${bash.path} (${bash.version})${RESET}`);

  let failures = 0;
  for (const probe of parsed.probes) {
    const result = await runProbe({
      bashPath: bash.path,
      preludePath: resolve(__dirname, '..', 'resources', 'prelude.sh'),
      sandboxProfilePath: resolve(__dirname, '..', 'resources', 'sandbox.sb'),
      scriptPath,
      workspaceRoot: dirname(scriptPath),
      probe,
      hasSourceGuard: parsed.hasSourceGuard,
      watchVariables: parsed.watchableVariableNames,
      timeoutMs: 10_000,
      maxRecords: 50_000,
      maxCloneBytes: 2e9,
      enforceSandbox: true,
    });
    printResult(source, result);
    if (result.verdict.kind === 'fail') failures++;
  }
  return failures ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`${RED}${error instanceof Error ? error.message : String(error)}${RESET}`);
    process.exit(1);
  });
