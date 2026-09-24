import * as vscode from 'vscode';
import { probeLenses } from './probeSelection';
import type { RunResult, Selection } from './types';

/**
 * Puts a lens on each probe's comment line so the active probe can be switched
 * without re-running. The lens titles come from `probeSelection`; this class
 * only holds the last run's results and turns that plain data into VS Code
 * objects.
 */
export class ProbeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  private results: RunResult[] = [];
  private selection: Selection = { kind: 'one', index: 0 };
  private documentUri: string | undefined;

  update(document: vscode.TextDocument, results: RunResult[], selection: Selection): void {
    this.documentUri = document.uri.toString();
    this.results = results;
    this.selection = selection;
    this.changed.fire();
  }

  clear(): void {
    this.documentUri = undefined;
    this.results = [];
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.toString() !== this.documentUri) return [];
    return probeLenses(this.results, this.selection).map((lens) => {
      const line = Math.min(lens.lineIndex, document.lineCount - 1);
      const range = document.lineAt(Math.max(line, 0)).range;
      return new vscode.CodeLens(range, {
        title: lens.title,
        command: lens.command,
        arguments: lens.args,
      });
    });
  }

  dispose(): void {
    this.changed.dispose();
  }
}
