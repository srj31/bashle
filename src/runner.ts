import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Probe, RunResult, Trace } from './types';
import { applyProcessExitCode, parseTrace } from './traceParser';
import { detectChanges, snapshotDirectory } from './fsDiffer';
import { createScratchClone, type ScratchWorkspace } from './scratch';
import { buildSandboxProfile } from './sandbox';
import { quoteShellWord, splitShellWords } from './shellWords';
import { evaluateVerdict } from './verdict';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const TRACE_FILE_DESCRIPTOR = 9;
const STDIO_BEFORE_TRACE_FD = ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore'] as const;

export interface RunProbeOptions {
  bashPath: string;
  preludePath: string;
  scriptPath: string;
  workspaceRoot: string;
  probe: Probe;
  hasSourceGuard: boolean;
  watchVariables: string[];
  timeoutMs: number;
  maxRecords: number;
  maxCloneBytes: number;
  enforceSandbox: boolean;
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  rawTrace: string;
  exitCode: number | null;
  timedOut: boolean;
}

function scratchPathFor(scratch: ScratchWorkspace, workspaceRoot: string, path: string): string {
  return join(scratch.root, relative(workspaceRoot, path));
}

async function writeFunctionDriver(
  scratch: ScratchWorkspace,
  scriptInScratch: string,
  probe: Probe,
): Promise<string> {
  const args = splitShellWords(probe.argsRaw).map(quoteShellWord).join(' ');
  const driverPath = join(scratch.bookkeepingDirectory, 'driver.sh');
  await writeFile(
    driverPath,
    `source ${quoteShellWord(scriptInScratch)}\n${probe.target} ${args}\n`,
    'utf8',
  );
  return driverPath;
}

function buildCommand(options: {
  bashPath: string;
  entryScript: string;
  argv: string[];
  profilePath: string | null;
}): { command: string; args: string[] } {
  const bashInvocation = [options.entryScript, ...options.argv];
  if (!options.profilePath) return { command: options.bashPath, args: bashInvocation };
  return {
    command: SANDBOX_EXEC,
    args: ['-f', options.profilePath, options.bashPath, ...bashInvocation],
  };
}

function spawnTraced(
  command: string,
  args: string[],
  spawnOptions: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string },
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      detached: true,
      stdio: [...STDIO_BEFORE_TRACE_FD, 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const traceChunks: Buffer[] = [];
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const extraDescriptors = child.stdio as unknown as Array<NodeJS.ReadableStream | null>;
    extraDescriptors[TRACE_FILE_DESCRIPTOR]?.on('data', (chunk: Buffer) => traceChunks.push(chunk));

    const killTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, spawnOptions.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(killTimer);
      reject(error);
    });

    child.on('close', (exitCode) => {
      clearTimeout(killTimer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        rawTrace: Buffer.concat(traceChunks).toString('utf8'),
        exitCode,
        timedOut,
      });
    });

    if (spawnOptions.stdin !== undefined) child.stdin?.write(spawnOptions.stdin);
    child.stdin?.end();
  });
}

function retargetTraceToWorkspace(trace: Trace, scriptPath: string): Trace {
  return {
    ...trace,
    executions: trace.executions.map((execution) => ({ ...execution, source: scriptPath })),
  };
}

export async function runProbe(options: RunProbeOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const scratch = await createScratchClone({
    sourceRoot: options.workspaceRoot,
    maxBytes: options.maxCloneBytes,
  });

  try {
    const before = await snapshotDirectory(scratch.root);
    const scriptInScratch = scratchPathFor(scratch, options.workspaceRoot, options.scriptPath);

    const isFunctionProbe = options.probe.kind === 'function';
    if (isFunctionProbe && !options.hasSourceGuard) {
      warnings.push(
        `${options.probe.target}() was probed by sourcing the script, which has no ` +
          `\`[[ "\${BASH_SOURCE[0]}" == "$0" ]]\` guard, so its top-level body ran first.`,
      );
    }

    const entryScript = isFunctionProbe
      ? await writeFunctionDriver(scratch, scriptInScratch, options.probe)
      : scriptInScratch;
    const argv = isFunctionProbe ? [] : splitShellWords(options.probe.argsRaw);

    let profilePath: string | null = null;
    if (options.enforceSandbox) {
      profilePath = join(scratch.bookkeepingDirectory, 'profile.sb');
      await writeFile(profilePath, buildSandboxProfile({ writableRoots: [scratch.root] }), 'utf8');
    } else {
      warnings.push('Sandbox enforcement is off; only the scratch clone is containing this run.');
    }

    const { command, args } = buildCommand({
      bashPath: options.bashPath,
      entryScript,
      argv,
      profilePath,
    });

    const outcome = await spawnTraced(command, args, {
      cwd: scratch.root,
      timeoutMs: options.timeoutMs,
      ...(options.probe.stdin !== undefined ? { stdin: options.probe.stdin } : {}),
      env: {
        ...process.env,
        ...options.probe.env,
        BASH_ENV: options.preludePath,
        HOME: scratch.home,
        TMPDIR: scratch.temp,
        _BASHLE_FD: String(TRACE_FILE_DESCRIPTOR),
        _BASHLE_MAX_RECORDS: String(options.maxRecords),
        _BASHLE_WATCH: options.watchVariables.join(' '),
      },
    });

    const trace = applyProcessExitCode(
      parseTrace(outcome.rawTrace, { includeSource: (source) => source === scriptInScratch }),
      outcome.exitCode,
    );

    if (trace.truncated) {
      warnings.push(`Tracing stopped after ${options.maxRecords} events; this trace is incomplete.`);
    }
    if (outcome.timedOut) {
      warnings.push(`Killed after ${options.timeoutMs} ms.`);
    }

    const changes = await detectChanges({
      scratchRoot: scratch.root,
      originalRoot: options.workspaceRoot,
      before,
    });

    return {
      probe: options.probe,
      trace: retargetTraceToWorkspace(trace, options.scriptPath),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      changes,
      verdict: evaluateVerdict(options.probe.expectation, outcome.stdout, outcome.exitCode),
      sandboxEnforced: profilePath !== null,
      durationMs: Date.now() - startedAt,
      warnings,
    };
  } finally {
    await scratch.dispose();
  }
}
