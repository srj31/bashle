import type { FileChange, Hole, RunResult } from './types';
import { holeLabel } from './holes';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const CHANGE_LABELS: Record<FileChange['kind'], string> = {
  created: 'created',
  modified: 'modified',
  deleted: 'deleted',
};

function renderDiff(diff: string): string {
  const lines = diff.split('\n').map((line) => {
    const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context';
    return `<div class="diff-line ${kind}">${escapeHtml(line)}</div>`;
  });
  return `<div class="diff">${lines.join('')}</div>`;
}

function renderChange(change: FileChange): string {
  const body = change.binary
    ? '<div class="note">binary file</div>'
    : change.diff
      ? renderDiff(change.diff)
      : '<div class="note">no diff available</div>';
  return `
    <details class="change ${change.kind}" ${change.kind === 'deleted' ? '' : 'open'}>
      <summary><span class="badge ${change.kind}">${CHANGE_LABELS[change.kind]}</span>${escapeHtml(change.path)}</summary>
      ${body}
    </details>`;
}

function renderFilesTab(results: RunResult[]): string {
  const changes = results.flatMap((result) => result.changes);
  if (changes.length === 0) {
    return '<p class="empty">This run changed no files.</p>';
  }
  return changes.map(renderChange).join('');
}

function renderTraceTab(results: RunResult[]): string {
  const rows = results.flatMap((result) =>
    result.trace.executions.map((execution) => {
      const status =
        execution.exitCode === undefined
          ? ''
          : `<span class="exit ${execution.exitCode ? 'bad' : 'good'}">${execution.exitCode}</span>`;
      const variables = Object.entries(execution.vars ?? {})
        .map(([name, value]) => `<span class="var">${escapeHtml(name)}=${escapeHtml(value)}</span>`)
        .join('');
      return `
        <tr data-line="${execution.lineNumber}">
          <td class="line">${execution.lineNumber}</td>
          <td class="iteration">${execution.occurrenceIndex + 1}</td>
          <td class="command"><code>${escapeHtml(execution.expanded ?? execution.unexpanded ?? '')}</code></td>
          <td class="status">${status}</td>
          <td class="vars">${variables}</td>
        </tr>`;
    }),
  );

  if (rows.length === 0) return '<p class="empty">Nothing executed.</p>';
  return `<table class="trace">
      <thead><tr><th>line</th><th>#</th><th>command as bash ran it</th><th>exit</th><th>variables</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

function renderOutputTab(results: RunResult[]): string {
  const sections = results.map((result) => {
    const title = result.probe.target ?? 'script';
    const stdout = result.stdout ? `<pre class="stdout">${escapeHtml(result.stdout)}</pre>` : '';
    const stderr = result.stderr ? `<pre class="stderr">${escapeHtml(result.stderr)}</pre>` : '';
    const nothing = stdout || stderr ? '' : '<p class="empty">No output.</p>';
    return `<section><h3>${escapeHtml(title)} ${escapeHtml(result.probe.argsRaw)}</h3>${stdout}${stderr}${nothing}</section>`;
  });
  return sections.join('');
}

/**
 * Suspect holes sort first and show their cause instead of a fill: the point
 * of the guard is that a fill is never the easiest thing to reach for next to
 * an expansion bug.
 */
/** The count is of open holes only; pre-filled ones are not work to do. */
function holesTabLabel(results: RunResult[]): string {
  const open = results.flatMap((result) => result.holes).filter((hole) => hole.state === 'open');
  return open.length ? `Holes (${open.length})` : 'Holes';
}

function renderHolesTab(results: RunResult[]): string {
  const holes = results.flatMap((result) => result.holes);
  if (holes.length === 0) return '<p class="empty">This run reached no holes.</p>';

  const rank = (hole: Hole) => (hole.suspect ? 0 : hole.state === 'open' ? 1 : 2);
  const ordered = [...holes].sort((a, b) => rank(a) - rank(b) || a.id - b.id);

  const rows = ordered.map((hole) => {
    const where = hole.lineNumber === undefined ? '' : `line ${hole.lineNumber}`;
    const detail = hole.suspect
      ? `<div class="suspect">$${escapeHtml(hole.suspect.emptyVariable)} was empty here</div>`
      : hole.state === 'open'
        ? [
            `<div class="goal">wants ${escapeHtml(hole.goal)}${
              hole.reaches.variables.length
                ? ` · reaches ${escapeHtml(hole.reaches.variables.join(', '))}`
                : ''
            }</div>`,
            `<pre class="fill">${escapeHtml(hole.suggestedFill)}</pre>`,
          ].join('')
        : `<div class="goal">${escapeHtml(hole.state)}</div>`;

    return `<section class="hole${hole.suspect ? ' is-suspect' : ''}">
      <h3>${escapeHtml(holeLabel(hole))} <code>${escapeHtml(hole.request)}</code> <span class="where">${escapeHtml(where)}</span></h3>
      ${detail}
    </section>`;
  });

  const diagnostics = results.flatMap((result) =>
    result.holeDiagnostics.map(
      (diagnostic) =>
        `<p class="suspect">\u25c7${diagnostic.holeId} was used as a number on line ${diagnostic.lineNumber}.</p>`,
    ),
  );

  return [...rows, ...diagnostics].join('');
}

function renderWarnings(results: RunResult[]): string {
  const warnings = results.flatMap((result) => result.warnings);
  if (warnings.length === 0) return '';
  return `<ul class="warnings">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
}

function renderSummary(results: RunResult[]): string {
  const changed = results.reduce((total, result) => total + result.changes.length, 0);
  const failures = results.filter((result) => result.verdict.kind === 'fail').length;
  const containment = results.every((result) => result.sandboxEnforced)
    ? '<span class="chip enforced">⛨ sandboxed</span>'
    : '<span class="chip unenforced">⚠ not enforced</span>';
  const duration = results.reduce((total, result) => total + result.durationMs, 0);
  const verdictChip = failures
    ? `<span class="chip bad">${failures} failing</span>`
    : '<span class="chip good">all expectations met</span>';
  return `<div class="summary">${containment}${verdictChip}<span class="chip">${changed} file changes</span><span class="chip">${duration} ms</span></div>`;
}

const STYLES = `
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
  .summary { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .chip { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 10px; font-size: 11px; }
  .chip.good { color: var(--vscode-testing-iconPassed); }
  .chip.bad, .chip.unenforced { color: var(--vscode-testing-iconFailed); }
  .chip.enforced { color: var(--vscode-testing-iconPassed); }
  nav { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
  nav button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--vscode-foreground);
               padding: 6px 12px; cursor: pointer; font-size: 12px; opacity: 0.7; }
  nav button.active { border-bottom-color: var(--vscode-focusBorder); opacity: 1; }
  .tab { display: none; } .tab.active { display: block; }
  .empty { opacity: 0.6; font-style: italic; }
  .warnings { background: var(--vscode-inputValidation-warningBackground); border-radius: 4px; padding: 8px 8px 8px 24px; margin: 0 0 12px; }
  table.trace { border-collapse: collapse; width: 100%; }
  table.trace th { text-align: left; font-weight: 500; opacity: 0.6; font-size: 11px; padding: 4px 8px; }
  table.trace td { padding: 3px 8px; border-top: 1px solid var(--vscode-panel-border); vertical-align: top; }
  td.line, td.iteration { font-variant-numeric: tabular-nums; opacity: 0.6; width: 1%; white-space: nowrap; }
  td.command code { font-family: var(--vscode-editor-font-family); white-space: pre-wrap; }
  .exit { font-variant-numeric: tabular-nums; }
  .hole h3 { font-weight: 500; font-size: 13px; margin: 12px 0 4px; }
  .hole .where { opacity: 0.6; font-size: 11px; }
  .hole .goal { opacity: 0.7; font-size: 12px; }
  .hole .fill { margin: 4px 0; padding: 4px 8px; background: var(--vscode-textCodeBlock-background); }
  .suspect { color: var(--vscode-editorWarning-foreground); font-size: 12px; }
  .exit.good { opacity: 0.5; } .exit.bad { color: var(--vscode-testing-iconFailed); font-weight: 600; }
  .var { font-family: var(--vscode-editor-font-family); margin-right: 8px; opacity: 0.8; }
  details.change { margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  details.change summary { cursor: pointer; padding: 6px 10px; font-family: var(--vscode-editor-font-family); }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 8px; padding: 1px 6px;
           border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.created { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
  .badge.deleted { background: var(--vscode-testing-iconFailed); color: var(--vscode-editor-background); }
  .diff { font-family: var(--vscode-editor-font-family); border-top: 1px solid var(--vscode-panel-border); }
  .diff-line { padding: 0 10px; white-space: pre-wrap; }
  .diff-line.added { background: var(--vscode-diffEditor-insertedTextBackground); }
  .diff-line.removed { background: var(--vscode-diffEditor-removedTextBackground); }
  pre.stdout, pre.stderr { font-family: var(--vscode-editor-font-family); white-space: pre-wrap;
                           padding: 8px 10px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
  pre.stderr { color: var(--vscode-testing-iconFailed); }
`;

const TAB_SCRIPT = `
  const buttons = document.querySelectorAll('nav button');
  buttons.forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('nav button, .tab').forEach((el) => el.classList.remove('active'));
    button.classList.add('active');
    document.getElementById(button.dataset.tab).classList.add('active');
  }));
`;

export function renderPanelHtml(
  results: RunResult[],
  activeTab: 'files' | 'holes' | 'trace' | 'output' = 'files',
): string {
  if (results.length === 0) {
    return `<style>${STYLES}</style><p class="empty">No probes have run yet. Add a <code># @probe</code> comment and save.</p>`;
  }

  const tabs: Array<['files' | 'holes' | 'trace' | 'output', string, string]> = [
    ['files', 'Files', renderFilesTab(results)],
    ['holes', holesTabLabel(results), renderHolesTab(results)],
    ['trace', 'Trace', renderTraceTab(results)],
    ['output', 'Output', renderOutputTab(results)],
  ];

  return `<style>${STYLES}</style>
    ${renderSummary(results)}
    ${renderWarnings(results)}
    <nav>${tabs
      .map(([id, label]) => `<button data-tab="${id}" class="${id === activeTab ? 'active' : ''}">${label}</button>`)
      .join('')}</nav>
    ${tabs.map(([id, , body]) => `<div class="tab ${id === activeTab ? 'active' : ''}" id="${id}">${body}</div>`).join('')}
    <script>${TAB_SCRIPT}</script>`;
}
