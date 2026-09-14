import * as vscode from 'vscode';
import { renderPanelHtml } from './panelContent';
import type { RunResult } from './types';

export type PanelTab = 'files' | 'trace' | 'output';

export class BashlePanel implements vscode.Disposable {
  private static readonly viewType = 'bashle.panel';

  private panel: vscode.WebviewPanel | undefined;
  private latestResults: RunResult[] = [];

  private create(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      BashlePanel.viewType,
      'Bashle',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    return panel;
  }

  reveal(activeTab: PanelTab = 'files'): void {
    this.panel ??= this.create();
    this.panel.webview.html = renderPanelHtml(this.latestResults, activeTab);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  update(results: RunResult[], activeTab: PanelTab = 'files'): void {
    this.latestResults = results;
    if (this.panel) this.panel.webview.html = renderPanelHtml(results, activeTab);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
