import * as vscode from 'vscode';
import { formatInlineAnnotation, formatHoverMarkdown, groupExecutionsByLine } from './annotations';
import type { LineExecution, RunResult } from './types';

const INLINE_MARGIN = '0 0 0 2.5em';

export class AnnotationRenderer implements vscode.Disposable {
  private readonly inlineAnnotation = vscode.window.createTextEditorDecorationType({
    after: {
      margin: INLINE_MARGIN,
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly failedAnnotation = vscode.window.createTextEditorDecorationType({
    after: {
      margin: INLINE_MARGIN,
      color: new vscode.ThemeColor('errorForeground'),
      fontStyle: 'italic',
    },
    overviewRulerColor: new vscode.ThemeColor('errorForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly passingVerdict = vscode.window.createTextEditorDecorationType({
    after: { margin: INLINE_MARGIN, color: new vscode.ThemeColor('testing.iconPassed') },
  });

  private readonly failingVerdict = vscode.window.createTextEditorDecorationType({
    after: { margin: INLINE_MARGIN, color: new vscode.ThemeColor('testing.iconFailed') },
    overviewRulerColor: new vscode.ThemeColor('testing.iconFailed'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  private endOfLine(document: vscode.TextDocument, lineIndex: number): vscode.Range {
    const line = document.lineAt(Math.min(lineIndex, document.lineCount - 1));
    return new vscode.Range(line.range.end, line.range.end);
  }

  private annotationFor(
    document: vscode.TextDocument,
    lineNumber: number,
    executions: LineExecution[],
  ): vscode.DecorationOptions | null {
    const lineIndex = lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= document.lineCount) return null;

    const lineText = document.lineAt(lineIndex).text;
    const annotation = formatInlineAnnotation(executions, lineText);
    if (!annotation) return null;

    return {
      range: this.endOfLine(document, lineIndex),
      renderOptions: { after: { contentText: annotation } },
      hoverMessage: new vscode.MarkdownString(formatHoverMarkdown(executions, lineText)),
    };
  }

  render(editor: vscode.TextEditor, results: RunResult[]): void {
    const document = editor.document;
    const succeeded: vscode.DecorationOptions[] = [];
    const failed: vscode.DecorationOptions[] = [];
    const passingVerdicts: vscode.DecorationOptions[] = [];
    const failingVerdicts: vscode.DecorationOptions[] = [];

    for (const result of results) {
      for (const [lineNumber, executions] of groupExecutionsByLine(result.trace.executions)) {
        const decoration = this.annotationFor(document, lineNumber, executions);
        if (!decoration) continue;
        const lastExitCode = executions[executions.length - 1]?.exitCode;
        (lastExitCode ? failed : succeeded).push(decoration);
      }

      const verdictRange = this.endOfLine(document, result.probe.commentLineIndex);
      if (result.verdict.kind === 'pass') {
        passingVerdicts.push({
          range: verdictRange,
          renderOptions: { after: { contentText: `✓ passed in ${result.durationMs} ms` } },
        });
      } else if (result.verdict.kind === 'fail') {
        failingVerdicts.push({
          range: verdictRange,
          renderOptions: {
            after: { contentText: `✗ expected ${result.verdict.expected} · got ${result.verdict.actual}` },
          },
        });
      }
    }

    editor.setDecorations(this.inlineAnnotation, succeeded);
    editor.setDecorations(this.failedAnnotation, failed);
    editor.setDecorations(this.passingVerdict, passingVerdicts);
    editor.setDecorations(this.failingVerdict, failingVerdicts);
  }

  clear(editor: vscode.TextEditor): void {
    for (const decoration of [
      this.inlineAnnotation,
      this.failedAnnotation,
      this.passingVerdict,
      this.failingVerdict,
    ]) {
      editor.setDecorations(decoration, []);
    }
  }

  dispose(): void {
    this.inlineAnnotation.dispose();
    this.failedAnnotation.dispose();
    this.passingVerdict.dispose();
    this.failingVerdict.dispose();
  }
}
