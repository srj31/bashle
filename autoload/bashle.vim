" Implementation for plugin/bashle.vim.
"
" The CLI does everything that matters: it runs the probe in the sandbox and
" hands back a report with the annotation text, the hover text and the holes
" already rendered. Nothing here re-derives presentation from the trace.

let s:root = expand('<sfile>:p:h:h')
let s:reports = {}
" Which probe each file is showing: an index into its probe list, or -1 for
" all of them. Drawing every probe stacks one annotation per probe onto each
" shared line, which is what this narrows.
let s:selected = {}
let s:jobs = {}
let s:types_defined = 0
let s:panel_name = 'bashle-panel'

function! s:cli() abort
  return empty(g:bashle_cli) ? s:root . '/dist/cli.js' : g:bashle_cli
endfunction

function! s:define_types() abort
  if s:types_defined || !g:bashle_has_virtual_text
    return
  endif
  " A missing highlight group makes prop_type_add throw, and losing the
  " annotations entirely over a colour is the wrong trade: drop to no virtual
  " text and say so once.
  try
    call prop_type_add('BashleOk',     {'highlight': 'BashleOk'})
    call prop_type_add('BashleFailed', {'highlight': 'BashleFailed'})
  catch /E969/
    " Already defined by an earlier run in this session.
  catch
    let g:bashle_has_virtual_text = 0
    echohl WarningMsg
    echomsg 'bashle: no virtual text (' . v:exception . '); panel and popup still work'
    echohl None
    return
  endtry
  let s:types_defined = 1
endfunction

function! s:panel_buffer() abort
  " Compared by name rather than looked up with bufnr(), which treats its
  " argument as a pattern.
  for l:nr in range(1, bufnr('$'))
    if bufexists(l:nr) && bufname(l:nr) ==# s:panel_name
      return l:nr
    endif
  endfor
  return -1
endfunction

function! s:buffer_for(path) abort
  let l:nr = bufnr(a:path)
  return l:nr > 0 && bufloaded(l:nr) ? l:nr : -1
endfunction

" ---------------------------------------------------------------- rendering

function! s:clear_buffer(bufnr) abort
  if !g:bashle_has_virtual_text || a:bufnr < 0
    return
  endif
  try
    call prop_remove({'type': 'BashleOk', 'bufnr': a:bufnr, 'all': 1})
    call prop_remove({'type': 'BashleFailed', 'bufnr': a:bufnr, 'all': 1})
  catch /E968\|E971/
    " No properties of that type in this buffer yet; nothing to remove.
  endtry
endfunction

function! s:selection(path) abort
  return get(s:selected, a:path, 0)
endfunction

" The probes to draw. Below two there is nothing to choose between, so the
" selection is ignored rather than hiding the only probe there is.
function! s:visible_probes(path, report) abort
  let l:probes = get(a:report, 'probes', [])
  let l:index = s:selection(a:path)
  if l:index < 0 || len(l:probes) < 2
    return l:probes
  endif
  return l:index < len(l:probes) ? [l:probes[l:index]] : [l:probes[0]]
endfunction

function! s:announce(path, probes) abort
  let l:index = s:selection(a:path)
  if l:index < 0
    echo printf('bashle: showing all %d probes', len(a:probes))
  else
    echo printf('bashle: showing probe %d of %d · %s',
          \ l:index + 1, len(a:probes), a:probes[l:index].label)
  endif
endfunction

function! s:render(path, report) abort
  let l:bufnr = s:buffer_for(a:path)
  if l:bufnr < 0
    return
  endif

  call s:define_types()
  call s:clear_buffer(l:bufnr)

  if !empty(get(a:report, 'errors', []))
    for l:error in a:report.errors
      echohl WarningMsg
      echomsg printf('bashle: line %d: %s', l:error.line, l:error.message)
      echohl None
    endfor
  endif

  if !g:bashle_has_virtual_text
    return
  endif

  let l:last = line('$')
  for l:probe in s:visible_probes(a:path, a:report)
    for l:annotation in l:probe.annotations
      if l:annotation.line < 1 || l:annotation.line > l:last
        continue
      endif
      call prop_add(l:annotation.line, 0, {
            \ 'bufnr': l:bufnr,
            \ 'type': l:annotation.failed ? 'BashleFailed' : 'BashleOk',
            \ 'text': '  ' . l:annotation.text,
            \ 'text_align': 'after',
            \ })
    endfor
  endfor
endfunction

" ------------------------------------------------------------------ running

function! s:on_out(path, channel, message) abort
  let s:jobs[a:path].output .= a:message
endfunction

function! s:on_err(path, channel, message) abort
  let s:jobs[a:path].errors .= a:message
endfunction

function! s:on_exit(path, job, status) abort
  let l:state = get(s:jobs, a:path, {})
  call remove(s:jobs, a:path)
  if empty(l:state)
    return
  endif

  if empty(trim(l:state.output))
    echohl WarningMsg
    echomsg 'bashle: no report (' . trim(l:state.errors) . ')'
    echohl None
    return
  endif

  try
    let l:report = json_decode(l:state.output)
  catch
    echohl WarningMsg
    echomsg 'bashle: could not read the report: ' . v:exception
    echohl None
    return
  endtry

  let s:reports[a:path] = l:report
  if s:selection(a:path) >= len(get(l:report, 'probes', []))
    let s:selected[a:path] = 0
  endif
  call s:render(a:path, l:report)
endfunction

function! bashle#run() abort
  let l:path = expand('%:p')
  if empty(l:path)
    echohl WarningMsg | echomsg 'bashle: this buffer has no file' | echohl None
    return
  endif
  if &modified
    echohl WarningMsg
    echomsg 'bashle: buffer has unsaved changes; probing what is on disk'
    echohl None
  endif
  if !filereadable(s:cli())
    echohl WarningMsg
    echomsg 'bashle: no CLI at ' . s:cli() . ' — run `npm run build:cli`, or set g:bashle_cli'
    echohl None
    return
  endif

  " A second save while the first run is still going would interleave two
  " reports for one file, so the earlier one is dropped.
  if has_key(s:jobs, l:path)
    call job_stop(s:jobs[l:path].job)
    call remove(s:jobs, l:path)
  endif

  let l:command = [g:bashle_node, s:cli(), '--json', l:path]
  let l:job = job_start(l:command, {
        \ 'out_cb': function('s:on_out', [l:path]),
        \ 'err_cb': function('s:on_err', [l:path]),
        \ 'exit_cb': function('s:on_exit', [l:path]),
        \ 'out_mode': 'raw',
        \ 'err_mode': 'raw',
        \ })
  let s:jobs[l:path] = {'job': l:job, 'output': '', 'errors': ''}
endfunction

function! bashle#clear() abort
  let l:path = expand('%:p')
  call s:clear_buffer(s:buffer_for(l:path))
  if has_key(s:reports, l:path)
    call remove(s:reports, l:path)
  endif
  if has_key(s:selected, l:path)
    call remove(s:selected, l:path)
  endif
endfunction

function! bashle#forget(path) abort
  if has_key(s:reports, a:path)
    call remove(s:reports, a:path)
  endif
  if has_key(s:selected, a:path)
    call remove(s:selected, a:path)
  endif
endfunction

" Choose which probe to show. No argument steps to the next one and wraps
" through 'all'; a number selects it (1-based); 'all' shows every probe.
" Repaints from the report already in hand — it never re-runs the script.
" Completion for :BashleProbe — the probe numbers this file actually has.
function! bashle#probe_complete(lead, line, pos) abort
  let l:probes = get(get(s:reports, expand('%:p'), {}), 'probes', [])
  return join(map(range(1, len(l:probes)), 'string(v:val)') + ['all'], "\n")
endfunction

function! bashle#probe(arg) abort
  let l:path = expand('%:p')
  let l:report = get(s:reports, l:path, {})
  let l:probes = get(l:report, 'probes', [])
  if empty(l:probes)
    echo 'bashle: no report yet — :BashleRun'
    return
  endif

  if a:arg ==# 'all'
    let s:selected[l:path] = -1
  elseif a:arg =~# '^\d\+$'
    let l:wanted = str2nr(a:arg) - 1
    if l:wanted < 0 || l:wanted >= len(l:probes)
      echohl WarningMsg
      echomsg printf('bashle: no probe %s — this file has %d', a:arg, len(l:probes))
      echohl None
      return
    endif
    let s:selected[l:path] = l:wanted
  elseif !empty(a:arg)
    echohl WarningMsg
    echomsg 'bashle: :BashleProbe takes a number, "all", or nothing'
    echohl None
    return
  else
    let l:index = s:selection(l:path)
    let s:selected[l:path] = l:index + 1 >= len(l:probes) ? -1 : l:index + 1
  endif

  call s:render(l:path, l:report)
  call s:announce(l:path, l:probes)
endfunction

" ------------------------------------------------------------------ inspect

" The hover is markdown because VS Code wants markdown; a popup does not, so
" the little that is markup gets stripped rather than shown as punctuation.
function! s:plain(markdown) abort
  let l:text = substitute(a:markdown, '\*\*\([^*]*\)\*\*', '\1', 'g')
  return substitute(l:text, '`', '', 'g')
endfunction

function! bashle#inspect() abort
  let l:report = get(s:reports, expand('%:p'), {})
  if empty(l:report)
    echo 'bashle: no report yet — :BashleRun'
    return
  endif

  let l:wanted = line('.')
  let l:lines = []
  for l:probe in s:visible_probes(expand('%:p'), l:report)
    for l:hover in l:probe.hovers
      if l:hover.line == l:wanted
        if !empty(l:lines) | call add(l:lines, '') | endif
        call add(l:lines, '── ' . l:probe.label)
        call extend(l:lines, split(s:plain(l:hover.markdown), '\n'))
      endif
    endfor
  endfor

  if empty(l:lines)
    echo 'bashle: line ' . l:wanted . ' did not run'
    return
  endif

  call popup_atcursor(l:lines, {
        \ 'border': [], 'padding': [0, 1, 0, 1], 'moved': 'any', 'wrap': 0,
        \ })
endfunction

" -------------------------------------------------------------------- panel

function! s:hole_lines(probe) abort
  if empty(a:probe.holes)
    return []
  endif
  let l:lines = ['', 'holes']
  " Suspect first: a hole that sits next to an empty variable is a bug to look
  " at, not an input to supply, so its fill is not what should be offered first.
  for l:hole in sort(copy(a:probe.holes), function('s:by_urgency'))
    let l:mark = has_key(l:hole, 'suspect') ? '◇!' : '◇'
    let l:where = has_key(l:hole, 'lineNumber') ? '  line ' . l:hole.lineNumber : ''
    call add(l:lines, printf('  %s%d %s%s', l:mark, l:hole.id, l:hole.request, l:where))
    if has_key(l:hole, 'suspect')
      call add(l:lines, '      $' . l:hole.suspect.emptyVariable . ' was empty here')
    elseif l:hole.state ==# 'open'
      call add(l:lines, '      wants ' . l:hole.goal)
      call add(l:lines, '      fill: ' . l:hole.suggestedFill)
    else
      call add(l:lines, '      ' . l:hole.state)
    endif
  endfor
  for l:diagnostic in a:probe.holeDiagnostics
    call add(l:lines, printf('  ◇%d was used as a number on line %d',
          \ l:diagnostic.holeId, l:diagnostic.lineNumber))
  endfor
  return l:lines
endfunction

function! s:by_urgency(a, b) abort
  let l:ra = has_key(a:a, 'suspect') ? 0 : (a:a.state ==# 'open' ? 1 : 2)
  let l:rb = has_key(a:b, 'suspect') ? 0 : (a:b.state ==# 'open' ? 1 : 2)
  return l:ra == l:rb ? a:a.id - a:b.id : l:ra - l:rb
endfunction

function! bashle#panel() abort
  let l:report = get(s:reports, expand('%:p'), {})
  if empty(l:report)
    echo 'bashle: no report yet — :BashleRun'
    return
  endif

  let l:path = expand('%:p')
  let l:shown = s:visible_probes(l:path, l:report)
  let l:total = len(get(l:report, 'probes', []))
  let l:heading = 'bashle · ' . fnamemodify(l:report.script, ':t')
  if l:total > 1
    let l:heading .= len(l:shown) == l:total
          \ ? printf('  ·  all %d probes', l:total)
          \ : printf('  ·  probe %d of %d  (:BashleProbe)', s:selection(l:path) + 1, l:total)
  endif
  let l:lines = [l:heading]
  for l:probe in l:shown
    call add(l:lines, '')
    call add(l:lines, '▶ probe: ' . l:probe.label)
    call extend(l:lines, s:hole_lines(l:probe))

    call add(l:lines, '')
    call add(l:lines, 'files changed in the sandbox')
    if empty(l:probe.changes)
      call add(l:lines, '  none')
    else
      for l:change in l:probe.changes
        let l:mark = l:change.kind ==# 'created' ? '+' : (l:change.kind ==# 'deleted' ? '-' : '~')
        call add(l:lines, '  ' . l:mark . ' ' . l:change.path)
      endfor
    endif

    for l:stream in ['stdout', 'stderr']
      if !empty(trim(l:probe[l:stream]))
        call add(l:lines, '')
        call add(l:lines, l:stream)
        call extend(l:lines, map(split(l:probe[l:stream], '\n'), '"  " . v:val'))
      endif
    endfor

    for l:warning in l:probe.warnings
      call add(l:lines, '⚠ ' . l:warning)
    endfor
    call add(l:lines, printf('exit %s · %s', string(l:probe.exitCode),
          \ l:probe.sandboxEnforced ? '⛨ sandboxed' : '⚠ not enforced'))
  endfor

  let l:existing = s:panel_buffer()
  if l:existing > 0
    execute 'sbuffer' l:existing
  else
    execute 'new' s:panel_name
  endif

  setlocal modifiable
  silent %delete _
  call setline(1, l:lines)
  setlocal buftype=nofile bufhidden=hide noswapfile nomodifiable nowrap
endfunction
