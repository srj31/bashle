import { describe, it, expect } from 'vitest';
import { renderPanelHtml, escapeHtml } from '../src/panelContent';
import type { RunResult } from '../src/types';

const result = (over: Partial<RunResult> = {}): RunResult => ({
  probe: { kind: 'script', argsRaw: '', env: {}, fills: [], commentLineIndex: 0, targetLineIndex: 1 },
  trace: { executions: [], holeRecords: [], truncated: false },
  stdout: '',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  changes: [],
  verdict: { kind: 'none' },
  holes: [],
  holeDiagnostics: [],
  sandboxEnforced: true,
  durationMs: 12,
  warnings: [],
  ...over,
});

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });
});

describe('renderPanelHtml', () => {
  it('invites the user to add a probe when nothing has run', () => {
    expect(renderPanelHtml([])).toContain('@probe');
  });

  it('says plainly when a run changed no files', () => {
    expect(renderPanelHtml([result()])).toContain('changed no files');
  });

  it('lists a created file with its diff', () => {
    const html = renderPanelHtml([
      result({ changes: [{ kind: 'created', path: 'out/result.txt', diff: '+hello' }] }),
    ]);
    expect(html).toContain('out/result.txt');
    expect(html).toContain('created');
    expect(html).toContain('diff-line added');
  });

  it('escapes script output rather than letting it render as markup', () => {
    const html = renderPanelHtml([result({ stdout: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a filename that contains markup', () => {
    const html = renderPanelHtml([
      result({ changes: [{ kind: 'created', path: '<b>evil</b>.txt' }] }),
    ]);
    expect(html).not.toContain('<b>evil</b>.txt');
  });

  it('shows the trace with the command bash actually ran', () => {
    const html = renderPanelHtml(
      [
        result({
          trace: {
            holeRecords: [],
            executions: [
              {
                lineNumber: 4,
                source: 'demo.sh',
                subshellLevel: 0,
                nestingDepth: 1,
                occurrenceIndex: 0,
                expanded: "cp 'a b' /bak/",
                exitCode: 1,
              },
            ],
            truncated: false,
          },
        }),
      ],
      'trace',
    );
    expect(html).toContain('cp &#039;a b&#039; /bak/');
    expect(html).toContain('exit bad');
  });

  it('flags a run that was not sandbox-enforced', () => {
    expect(renderPanelHtml([result({ sandboxEnforced: false })])).toContain('not enforced');
  });

  it('surfaces warnings above the tabs', () => {
    const html = renderPanelHtml([result({ warnings: ['top-level body ran first'] })]);
    expect(html).toContain('top-level body ran first');
    expect(html.indexOf('top-level body ran first')).toBeLessThan(html.indexOf('<nav>'));
  });

  it('counts failing expectations in the summary', () => {
    const html = renderPanelHtml([
      result({ verdict: { kind: 'fail', expected: 'a', actual: 'b' } }),
    ]);
    expect(html).toContain('1 failing');
  });
});
