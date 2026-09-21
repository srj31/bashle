" bashle — watch a bash script run, line by line, without letting it touch your machine.
"
" Vim front end. All the work happens in the bashle CLI; this file only decides
" when to run it and how to show what comes back.

if exists('g:loaded_bashle')
  finish
endif
let g:loaded_bashle = 1

if !has('job') || !exists('*json_decode')
  echohl WarningMsg
  echomsg 'bashle: needs a Vim with +job and json_decode()'
  echohl None
  finish
endif

" Virtual text needs text properties, which arrived in Vim 9.0. Without them the
" plugin still runs and still shows holes and files in the panel; it just cannot
" put annotations at the end of the line.
let g:bashle_has_virtual_text = has('textprop') && v:version >= 900

let g:bashle_run_on_save = get(g:, 'bashle_run_on_save', 1)
let g:bashle_node = get(g:, 'bashle_node', 'node')
let g:bashle_cli = get(g:, 'bashle_cli', '')

" Our own groups, linked by default, so a colourscheme can override them and a
" minimal Vim without the linked group still has something valid to name.
highlight default link BashleOk     Comment
highlight default link BashleFailed WarningMsg
highlight default link BashleHole   Question

command! BashleRun     call bashle#run()
command! BashleClear   call bashle#clear()
command! BashleInspect call bashle#inspect()
command! BashlePanel   call bashle#panel()

augroup bashle
  autocmd!
  autocmd BufWritePost *.sh,*.bash if g:bashle_run_on_save | call bashle#run() | endif
  autocmd BufUnload    *.sh,*.bash call bashle#forget(expand('<afile>:p'))
augroup END

if !hasmapto('<Plug>(bashle-run)')
  nmap <silent> <Leader>br <Plug>(bashle-run)
  nmap <silent> <Leader>bi <Plug>(bashle-inspect)
  nmap <silent> <Leader>bp <Plug>(bashle-panel)
endif

nnoremap <silent> <Plug>(bashle-run)     :<C-u>BashleRun<CR>
nnoremap <silent> <Plug>(bashle-inspect) :<C-u>BashleInspect<CR>
nnoremap <silent> <Plug>(bashle-panel)   :<C-u>BashlePanel<CR>
