import * as vscode from 'vscode';
import { dirname, join } from 'node:path';
import { parseProbes } from './probeParser';
import { discoverBash, type DiscoveredBash } from './bashDiscovery';
import { runProbe } from './runner';
import { AnnotationRenderer } from './decorations';
import { BashlePanel, type PanelTab } from './panel';
import type { RunResult } from './types';

const SHELL_LANGUAGE_ID = 'shellscript';

interface BashleSettings {
  bashPath: string;
  runOnSave: boolean;
  timeoutMs: number;
  enforceSandbox: boolean;
  maxRecords: number;
  maxCloneBytes: number;
  watchAllVariables: boolean;
}

function readSettings(): BashleSettings {
  const configuration = vscode.workspace.getConfiguration('bashle');
  return {
    bashPath: configuration.get('bashPath', ''),
    runOnSave: configuration.get('runOnSave', true),
    timeoutMs: configuration.get('timeoutMs', 5000),
    enforceSandbox: configuration.get('enforceSandbox', true),
    maxRecords: configuration.get('maxRecords', 50000),
    maxCloneBytes: configuration.get('maxCloneBytes', 536870912),
    watchAllVariables: configuration.get('watchAllVariables', false),
  };
}

function workspaceRootFor(document: vscode.TextDocument): string {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dirname(document.uri.fsPath);
}

class BashleSession implements vscode.Disposable {
  private readonly renderer = new AnnotationRenderer();
  private readonly panel = new BashlePanel();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('bashle');
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly preludePath: string;
  private readonly sandboxProfilePath: string;

  private bash: DiscoveredBash | undefined;
  private latestRunToken = 0;

  constructor(context: vscode.ExtensionContext) {
    this.preludePath = join(context.extensionPath, 'resources', 'prelude.sh');
    this.sandboxProfilePath = join(context.extensionPath, 'resources', 'sandbox.sb');
    this.statusBar.command = 'bashle.showPanel';
  }

  private async resolveBash(settings: BashleSettings): Promise<DiscoveredBash> {
    if (this.bash && (!settings.bashPath || this.bash.path === settings.bashPath)) return this.bash;
    this.bash = await discoverBash(settings.bashPath);
    return this.bash;
  }

  private reportParseErrors(document: vscode.TextDocument, errors: ReturnType<typeof parseProbes>['errors']): void {
    this.diagnostics.set(
      document.uri,
      errors.map(({ lineIndex, message }) => {
        const range = document.lineAt(Math.min(lineIndex, document.lineCount - 1)).range;
        return new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
      }),
    );
  }

  private describe(results: RunResult[]): string {
    const failures = results.filter((result) => result.verdict.kind === 'fail').length;
    const changed = results.reduce((total, result) => total + result.changes.length, 0);
    const containment = results.every((result) => result.sandboxEnforced) ? '⛨' : '⚠';
    if (failures) return `${containment} Bashle: ${failures} failing`;
    return `${containment} Bashle: ${results.length} probes · ${changed} file changes`;
  }

  async run(document: vscode.TextDocument, activeTab: PanelTab = 'files'): Promise<void> {
    if (document.languageId !== SHELL_LANGUAGE_ID) return;

    const settings = readSettings();
    const parsed = parseProbes(document.getText());
    this.reportParseErrors(document, parsed.errors);

    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);

    if (parsed.probes.length === 0) {
      if (editor) this.renderer.clear(editor);
      this.panel.update([], activeTab);
      this.statusBar.text = 'Bashle: no probes';
      this.statusBar.show();
      return;
    }

    const runToken = ++this.latestRunToken;
    this.statusBar.text = `$(sync~spin) Bashle: running ${parsed.probes.length} probe(s)`;
    this.statusBar.show();

    try {
      const bash = await this.resolveBash(settings);
      const results: RunResult[] = [];

      for (const probe of parsed.probes) {
        results.push(
          await runProbe({
            bashPath: bash.path,
            preludePath: this.preludePath,
            sandboxProfilePath: this.sandboxProfilePath,
            scriptPath: document.uri.fsPath,
            workspaceRoot: workspaceRootFor(document),
            probe,
            hasSourceGuard: parsed.hasSourceGuard,
            watchVariables: settings.watchAllVariables ? [] : parsed.watchableVariableNames,
            timeoutMs: settings.timeoutMs,
            maxRecords: settings.maxRecords,
            maxCloneBytes: settings.maxCloneBytes,
            enforceSandbox: settings.enforceSandbox,
          }),
        );
      }

      if (runToken !== this.latestRunToken) return;

      if (editor) this.renderer.render(editor, results);
      this.panel.update(results, activeTab);
      this.statusBar.text = this.describe(results);
    } catch (error) {
      if (runToken !== this.latestRunToken) return;
      const message = error instanceof Error ? error.message : String(error);
      this.statusBar.text = '$(error) Bashle: failed';
      vscode.window.showErrorMessage(message);
    }
  }

  revealPanel(tab: PanelTab): void {
    this.panel.reveal(tab);
  }

  clear(): void {
    this.latestRunToken++;
    for (const editor of vscode.window.visibleTextEditors) this.renderer.clear(editor);
    this.diagnostics.clear();
    this.panel.update([]);
    this.statusBar.hide();
  }

  dispose(): void {
    this.renderer.dispose();
    this.panel.dispose();
    this.diagnostics.dispose();
    this.statusBar.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const session = new BashleSession(context);
  context.subscriptions.push(session);

  context.subscriptions.push(
    vscode.commands.registerCommand('bashle.run', () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document) void session.run(document);
    }),
    vscode.commands.registerCommand('bashle.drillDown', () => {
      const document = vscode.window.activeTextEditor?.document;
      session.revealPanel('trace');
      if (document) void session.run(document, 'trace');
    }),
    vscode.commands.registerCommand('bashle.showPanel', () => session.revealPanel('files')),
    vscode.commands.registerCommand('bashle.clear', () => session.clear()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (readSettings().runOnSave) void session.run(document);
    }),
  );
}

export function deactivate(): void {}
