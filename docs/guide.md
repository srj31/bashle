# The bashle guide

This guide takes you from installing bashle to probing scripts that call the network. You only need
to be able to read a bash script. How bashle works inside is covered [elsewhere](internals.md).

- [What bashle does](#what-bashle-does)
- [Set up](#set-up)
- [Your first probe](#your-first-probe)
- [Reading the results](#reading-the-results)
- [Writing probes](#writing-probes)
- [Network calls and other unknowns](#network-calls-and-other-unknowns)
- [Is it safe?](#is-it-safe)
- [Reference](#reference)
- [Troubleshooting](#troubleshooting)

## What bashle does

Each time you save a bash script, bashle:

1. makes a disposable copy of your project,
2. runs the script inside that copy, in a sandbox that keeps it away from the rest of your machine,
3. writes, at the end of each line, the command bash actually ran and what happened.

You tell bashle how to run the script with a **probe**: a comment such as `# @probe staging`,
meaning "run this script with the argument `staging`". Probes are ordinary comments, so the
script works the same everywhere else.

## Set up

You need:

- **macOS or Linux.**
- **bash 4.1 or newer.** macOS comes with bash 3.2, which is too old: run `brew install bash`, and
  bashle finds the new one by itself.
- **On Linux, bubblewrap**, which bashle uses as its sandbox: `sudo apt install bubblewrap` or
  `sudo dnf install bubblewrap`. macOS has its sandbox built in.

### VS Code, Cursor, VSCodium

- **Cursor, VSCodium and other editors that use Open VSX:** search for *Bashle* in the Extensions
  view and install it.
- **VS Code** (1.85 or newer): download the `.vsix` file from
  [Open VSX](https://open-vsx.org/extension/srj31/bashle) and run
  `code --install-extension <the file you downloaded>`.

### Vim

Needs Vim 9.0 or newer to show results at the end of lines. On Vim 8.2 the panel and the popup still
work. You also need Node.js.

```vim
Plug 'srj31/bashle'
```

```bash
cd ~/.vim/plugged/bashle && npm install && npm run build:cli
```

### The terminal

From a clone of the repository:

```bash
npm install
npm run probe -- path/to/script.sh
```

## Your first probe

Create `hello.sh` in any folder you've opened in your editor:

```bash
#!/usr/bin/env bash
# @probe world
name=$1
greeting="Hello, $name"
echo "$greeting"
```

Save it. Each line now ends with a note:

```bash
#!/usr/bin/env bash
# @probe world
name=$1                  name=world
greeting="Hello, $name"  greeting='Hello, world'  name=world
echo "$greeting"         echo 'Hello, world'  greeting='Hello, world'
```

Each note has two parts. First comes the command as bash ran it, with every `$variable` already
replaced. After it come the values of the variables the line mentions.

Now turn the probe into a check. Change the comment to:

```bash
# @probe world => "Hello, world"
```

Save again. The probe line now says `✓ passed in 33 ms`. Change the expected text to `"Hi, world"`
and it says `✗ expected Hi, world · got Hello, world`.

That's all bashle asks of you: write a probe, then save.

## Reading the results

### The note at the end of a line

| You see | It means |
|---|---|
| `mkdir -p backup` | The command as bash ran it, after filling in variables. |
| `name=world` | A variable the line mentions, and its value just before the line ran. Up to three are shown. |
| `'Hello, world'` | Quotes mean *one piece*: bash treated the value as a single argument, spaces and all. |
| `✗1` | The command failed, with exit status 1. The note is shown in red. |
| `f=a.txt · b.txt · c.txt` | The line ran more than once (in a loop, say), and `f` had each of these values, in order. On a line that sets `f`, like the loop's `for f in …`, they're the values it was set to. The rest of the note shows the last run; hover to see each one. A long list ends with `… +82 more`. |
| `◇1` | A placeholder for something bashle couldn't know, like a download. See [holes](#network-calls-and-other-unknowns). |
| `◇!1 $url was empty here` | A placeholder next to an empty variable, which is probably a bug. See [below](#when-a-hole-is-really-a-bug). |
| *(no note)* | The line didn't run. |

Quotes matter most. Here is a line whose variable wasn't quoted:

```bash
cp $file "$backup_dir/"        cp reports/Q3 report.txt backup/  ✗1
```

No quotes appear around `reports/Q3 report.txt`, so bash split the filename at the space and handed
`cp` two arguments. `examples/backup.sh` has this bug if you want to try it.

### The result of a check

It appears on the `# @probe` line itself: `✓ passed in 44 ms`, or `✗ expected exit 0 · got exit 1`.

### More detail

- **Hover over a line** to see every time it ran, numbered, each with its own values.
- **The Bashle panel** opens when you click *Bashle* in the status bar, or run *Bashle: Show
  panel*. It has four tabs:
  - **Files** lists every file the script created, changed or deleted in the copy, with the changes.
  - **Holes** lists every placeholder, with a ready-made line to fill it.
  - **Trace** shows every command in the order it ran.
  - **Output** shows what the script printed.
- **The status bar** shows `⛨` when the sandbox is on and `⚠` when it isn't. See
  [Is it safe?](#is-it-safe)

In Vim, `:BashleInspect` shows the hover for the line under the cursor, and `:BashlePanel` opens the
panel.

## Writing probes

### Run the whole script

```bash
# @probe staging --dry-run
```

Everything after `@probe` is passed to the script as its arguments (`$1`, `$2`, …). Quote the way
you would in a terminal: `# @probe "two words"` is a single argument.

You can put a probe anywhere in the file, except directly above a function (see below). If your
script opens with a helper function, leave a blank line between the probe and the function, and the
probe runs the whole script.

### Run one function

Put the probe directly above the function, with no blank line between them. The arguments then go
to the function:

```bash
# @probe "a//b" => "a/b"
normalize_path() {
  echo "${1//\/\//\/}"
}
```

To call the function, bashle loads the script with `source`, which also runs any code outside
functions. If your script does real work at the top level, wrap it so it only runs when the script
is run directly:

```bash
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```

Bashle warns you when it has to load a script that doesn't have this check.

### Checks

End a probe with `=>` to make it a check:

| You write | It passes when |
|---|---|
| `# @probe staging => exit 0` | the script exits with status 0 |
| `# @probe "a//b" => "a/b"` | the script prints exactly `a/b` (trailing newlines are ignored) |

Without `=>`, the probe just runs and shows you what happened.

### Several probes

Put one per line in the same comment block. Each runs on its own, in a fresh copy:

```bash
# @probe staging => exit 0
# @probe prod => exit 1
```

To keep the notes readable, bashle shows one probe's results at a time. In VS Code, click the link
above a probe's comment line to switch (*show*, *show all*, *show only this*). In Vim, use
`:BashleProbe` to step through them, `:BashleProbe 2` to pick one, or `:BashleProbe all` to show all.
Switching doesn't re-run anything.

### Environment variables and input

These lines apply to every probe in the same comment block:

```bash
# @env DEPLOY_ENV=staging
# @stdin "yes"
# @probe --interactive
```

`@env` sets an environment variable. `@stdin` is one line of text the script reads from its input,
for example with `read`.

### Mistakes in a probe

If bashle can't understand a probe comment, it tells you rather than guessing. VS Code underlines
the line, Vim prints a message, and the terminal prints `line N: …`.

## Network calls and other unknowns

Some commands can't be run safely, or give a different answer every time: a download, a command sent
to a server, reading a file that isn't in your project. Bashle doesn't run these. It hands back a
placeholder called a **hole**, shown as `◇1`, `◇2`, …, and lets the script carry on.

```bash
# @probe staging
set -euo pipefail
version=$(curl -fsS "https://releases.example.com/latest")   version=◇1  ◇1
dest="releases/$1-$version"                                  dest=releases/staging-◇1  version=◇1
mkdir -p "$dest"                                             mkdir -p releases/staging-◇1  dest=releases/staging-◇1
echo "$version" > "$dest/VERSION"                            echo ◇1  version=◇1  dest=releases/staging-◇1
```

Nothing was downloaded, and you can already see where the answer would go: into a folder name, and
into a file. The Files tab shows that file as `releases/staging-◇1/VERSION`.

### What becomes a hole

| The script runs | It becomes a hole named |
|---|---|
| `curl` or `wget` | the method and address, e.g. `GET https://releases.example.com/latest` |
| `ssh`, `docker`, `kubectl`, `aws`, `systemctl`, `launchctl`, `nc` | the command, e.g. `docker ps` |
| `cat`, `head`, `tail`, `wc`, `sort`, `cut` and similar, on a file that doesn't exist | the file's path |

Files that do exist in your project are read normally.

A few commands always give the same answer, so that two runs agree: `date` says it is
2026-01-01 00:00 UTC, `hostname` and `whoami` say `bashle`, and `uuidgen` returns a fixed ID.

### Filling a hole

To give a hole an answer, add a line to the probe's comment block. The easiest way is to copy the
suggested line from the Holes tab or the hover, which already has the exact request, and change the
value:

```bash
# @net GET https://releases.example.com/latest => "1.4.2"
# @probe staging
```

Save, and `◇1` becomes `1.4.2` everywhere it appeared:

```bash
dest="releases/$1-$version"      dest=releases/staging-1.4.2  version=1.4.2
```

There are four kinds of fill:

| Line | Answers |
|---|---|
| `# @net GET https://example.com/x => …` | a `curl` or `wget` call |
| `# @cmd docker ps => …` | `ssh`, `docker` or another command from the table above, or `date`, `hostname`, `whoami`, `uuidgen` |
| `# @file config/app.conf => …` | a file the script reads. Bashle creates it in the copy before the run. The path must be relative to your project. |
| `# @clock 2026-03-01T09:00:00Z` | what time `date` reports |

And a few ways to write the answer after `=>`:

| After `=>` | The command |
|---|---|
| `"1.4.2"` | prints `1.4.2` and succeeds |
| `exit 22` | prints nothing and fails with status 22 |
| `"not found" exit 22` | prints `not found` and fails with status 22 |
| `@fixtures/latest.json` | prints the contents of that file in your project, and succeeds |

For an answer that spans several lines, use a heredoc inside the comments:

```bash
# @net GET https://api.example.com/status => <<'EOF'
#   {
#     "status": "ok"
#   }
# EOF
# @probe staging
```

The request has to match exactly, down to the address, which is why copying the suggested line is
easiest. Each request can be filled once per comment block.

### When a hole is really a bug

If the line that made a hole also used an empty variable, bashle marks it `◇!` and names the variable
instead of suggesting a fill:

```bash
api_url=${API_URL:-}           api_url=
curl -fsS "$api_url/health"    curl -fsS /health  api_url=  ◇!1 $api_url was empty here
```

Filling this hole would only hide the mistake. Fix the variable first.

Similarly, if a placeholder ends up in arithmetic, such as `(( count > 3 ))` or `-eq`, bashle notes
*◇1 was used as a number on line N*. A placeholder isn't a number, so fill that hole with one.

Holes have a few known blind spots, such as a missing file read with `source` or `read < file`.
They're listed in [the semantics](semantics.md).

## Is it safe?

Probes run real commands, so bashle contains them in layers:

1. **A copy of your project.** The script runs in a throwaway copy, and your real files are never
   touched. On macOS, and on Linux with btrfs or XFS, the copy is instant and takes no extra disk
   space until something writes to it. `.git` and `node_modules` aren't copied, and you can leave out more
   with a [`.bashleignore`](using-in-a-repository.md) file. `HOME` and `TMPDIR` also point inside
   the copy.
2. **A sandbox from the operating system:** `sandbox-exec` on macOS, bubblewrap on Linux. It blocks
   writing anywhere outside the copy, all network access, and `sudo` and `su`.
3. **Holes** for downloads and for commands that act on other machines or services, so those never
   run at all.

Bashle always says which protection you have: `⛨ sandboxed` when the sandbox is on, `⚠ not enforced`
when only the copy protects you. The second happens if you turn off `bashle.enforceSandbox`, if
bubblewrap isn't installed, or if your Linux system doesn't let bubblewrap create a sandbox.

**What it can't protect you from:** commands that ask *another* program to do the work, such as
`docker` talking to the Docker service, or `systemctl` to the system. The sandbox only limits the
script itself. Bashle turns the common ones into holes, as listed above, but for scripts like that,
turn off `bashle.runOnSave` and run probes deliberately.

Each run is also stopped after 5 seconds (`bashle.timeoutMs`).

## Reference

### VS Code commands

| Command | macOS | Linux | What it does |
|---|---|---|---|
| Bashle: Run probes in this file | `⌘⌥R` | `Ctrl+Alt+R` | Runs every probe. Also the ▶ button at the top of the editor. |
| Bashle: Inspect this line | `⌘⌥I` | `Ctrl+Alt+I` | Runs the probes and opens the panel on the Trace tab. |
| Bashle: Show panel | | | Opens the panel. Clicking *Bashle* in the status bar does the same. |
| Bashle: Clear annotations | | | Removes every note. |

### VS Code settings

| Setting | Default | What it does |
|---|---|---|
| `bashle.runOnSave` | `true` | Run probes every time you save. |
| `bashle.timeoutMs` | `5000` | Stop a run after this many milliseconds. |
| `bashle.enforceSandbox` | `true` | Use the operating system sandbox. If off, only the copy protects you. |
| `bashle.bashPath` | *(empty)* | Which bash to use. Empty means find one automatically. |
| `bashle.maxCloneBytes` | `536870912` (512 MB) | Refuse to copy a project bigger than this. |
| `bashle.maxRecords` | `50000` | Stop recording after this many steps. The results are marked incomplete. |
| `bashle.watchAllVariables` | `false` | Record every variable, not only the ones the script names. Slower. |

To set these for one project, put them in `.vscode/settings.json`. See
[Using bashle in a real repository](using-in-a-repository.md).

### Vim

| Command | Keys | What it does |
|---|---|---|
| `:BashleRun` | `<Leader>br` | Run the probes in this file. Also happens on save. |
| `:BashleInspect` | `<Leader>bi` | Show every run of the line under the cursor. |
| `:BashlePanel` | `<Leader>bp` | Holes, changed files and output, in a split. |
| `:BashleProbe` | `<Leader>bn` | Show the next probe. `:BashleProbe 2` picks one, `:BashleProbe all` shows every probe. |

Options: `g:bashle_run_on_save` (default `1`), `g:bashle_node` (the `node` to use), `g:bashle_cli`
(where the built CLI is). Colours follow the `BashleOk`, `BashleFailed` and `BashleHole` highlight
groups.

Vim runs a saved file, not unsaved changes.

### The terminal

```bash
npm run probe -- script.sh           # results, annotated, in colour
npm run probe -- --json script.sh    # the same results as JSON, for other tools
```

It exits with status 1 if any check failed.

**Vim and the terminal copy the script's own folder, not the whole project.** In both, paths the
script uses are relative to the script's folder. Neither reads the VS Code settings: runs stop after
10 seconds, and the sandbox is always on.

## Troubleshooting

**"Bashle needs bash 4.1 or newer."** Install a newer bash (`brew install bash` on macOS), or point
`bashle.bashPath` at one you already have.

**"This workspace is … MB, above the … MB clone limit."** List what the script doesn't need in a
[`.bashleignore`](using-in-a-repository.md), or raise `bashle.maxCloneBytes`.

**`⚠ not enforced`.** On Linux, install bubblewrap. If it's installed and still can't create a
sandbox, your system is blocking what it needs ("unprivileged user namespaces"). Some distributions,
Ubuntu 24.04 among them, block these by default.

**"… was probed by sourcing the script …, so its top-level body ran first."** Add the
`BASH_SOURCE` check shown in [Run one function](#run-one-function).

**"Killed after 5000 ms."** The script ran too long. Raise `bashle.timeoutMs`.

**"Tracing stopped after 50000 events."** The script ran a lot of commands, and the results are cut
short. Raise `bashle.maxRecords`.

**"Nothing follows this `@probe` for it to run."** The probe is at the end of the file. Move it above
some code.

**A line has no note.** That line didn't run. Code inside pipelines and subshells is also recorded
less precisely; see [what's covered](internals.md#coverage).

**The script can't find a file that's next to it.** In VS Code, the script runs from the project's
top folder, not its own. Add `cd "$(dirname "$0")"` at the top if it expects its own folder.
