<p align="center">
  <img src="media/banner.png" alt="bashle — a live programming environment for bash scripts" width="100%">
</p>

<p align="center">
  <em>See what your bash script actually runs, line by line, every time you save,<br>
  without letting it touch your machine.</em>
</p>

<p align="center">
  <a href="https://github.com/srj31/bashle/actions/workflows/ci.yml"><img src="https://github.com/srj31/bashle/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/srj31/bashle/actions/workflows/ci.yml"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fsrj31%2F5d384b7a71e1d079d23a2cf984cd2def%2Fraw%2Fbashle-coverage.json" alt="coverage"></a>
  <a href="https://open-vsx.org/extension/srj31/bashle"><img src="https://img.shields.io/open-vsx/v/srj31/bashle?label=Open%20VSX" alt="Open VSX"></a>
</p>

---

Bashle runs your bash script in a throwaway sandbox every time you save, and writes what bash
actually ran at the end of each line:

```bash
# @probe "reports/Q3 report.txt"
file=$1                        file='reports/Q3 report.txt'
rm -rf "$backupdir/partial"    rm -rf /partial
cp $file "$backup_dir/"        cp reports/Q3 report.txt backup/  ✗1
```

A typo'd variable pointed `rm` at `/partial`, and an unquoted `$file` split in two. You see both
without running anything against your real files.

- [Set up](#set-up): VS Code, Neovim, Vim, the terminal
- [Probes](#probes): telling bashle how to run a script
- [Holes](#holes): what happens to network calls and other unknowns

## Set up

Everywhere you need **macOS or Linux** and **bash 4.1 or newer**.

- macOS ships bash 3.2, so run `brew install bash`. Bashle finds the new one on its own.
- On Linux, install the sandbox: `sudo apt install bubblewrap` (or `dnf install bubblewrap`).

### VS Code (and Cursor, VSCodium)

- **Cursor, VSCodium**: search for *Bashle* in the Extensions view and install it.
- **VS Code** 1.85+: download the `.vsix` from
  [Open VSX](https://open-vsx.org/extension/srj31/bashle), then
  `code --install-extension <the file>`.

Open any `.sh` file and save it. Notes appear at the end of each line; click *Bashle* in the status
bar for the panel.

### Neovim and Vim

Needs Neovim 0.5+ or Vim 9.0+, plus Node.js. The plugin runs a small CLI that you build once.

With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{ "srj31/bashle", build = "npm install && npm run build:cli", ft = "sh" }
```

With [vim-plug](https://github.com/junegunn/vim-plug):

```vim
Plug 'srj31/bashle', { 'do': 'npm install && npm run build:cli' }
```

Save a `.sh` file to run it. Useful commands:

| Command | Keys | Does |
|---|---|---|
| `:BashleRun` | `<Leader>br` | Run the probes (also runs on save) |
| `:BashleInspect` | `<Leader>bi` | Show every run of the current line, in a popup |
| `:BashlePanel` | `<Leader>bp` | Holes, changed files and output in a split |
| `:BashleProbe` | `<Leader>bn` | Switch which probe's results are shown |

On Vim 8.2 the panel and popup work, but there are no end-of-line notes.

### The terminal

From a clone of the repository:

```bash
npm install
npm run probe -- path/to/script.sh          # annotated, in colour
npm run probe -- --json path/to/script.sh   # the same, as JSON
```

It exits with status 1 if any check failed, so it works in CI.

## Probes

A probe is a comment saying how to run the script. Everything after `@probe` becomes the script's
arguments, quoted like in a terminal:

```bash
#!/usr/bin/env bash
# @probe world
name=$1                  name=world
echo "Hello, $name"      echo 'Hello, world'  name=world
```

**Make it a check** by adding `=>`:

```bash
# @probe world => "Hello, world"     # passes if it prints exactly this
# @probe staging => exit 0           # passes if it exits 0
```

The result shows on the probe line: `✓ passed in 33 ms` or `✗ expected … · got …`.

**Test one function** by putting the probe directly above it, with no blank line:

```bash
# @probe "a//b" => "a/b"
normalize_path() {
  echo "${1//\/\//\/}"
}
```

**Several probes**: one per line. Each runs in its own fresh copy.

```bash
# @probe staging => exit 0
# @probe prod => exit 1
```

**Environment and input** apply to every probe in the same comment block:

```bash
# @env DEPLOY_ENV=staging
# @stdin "yes"
# @probe --interactive
```

## Holes

Bashle never makes real network calls or talks to other machines. When a script runs `curl`,
`wget`, `ssh`, `docker`, `kubectl`, `aws` and the like, or reads a file that doesn't exist, bashle
hands back a placeholder called a **hole** and keeps going. There are two kinds.

### `◇` — an unknown value

The answer is something bashle can't know. You can follow it through the script:

```bash
version=$(curl -fsS "https://releases.example.com/latest")   version=◇1
dest="releases/$1-$version"                                  dest=releases/staging-◇1
```

Fill it by adding a line to the probe's comment block (the Holes panel and the hover give you this
line ready to copy):

```bash
# @net GET https://releases.example.com/latest => "1.4.2"
# @probe staging
```

Now `◇1` reads `1.4.2` everywhere. Other fills work the same way:

| Line | Answers |
|---|---|
| `# @net GET https://… => "…"` | `curl` / `wget` |
| `# @cmd docker ps => "…"` | `ssh`, `docker`, and other commands |
| `# @file config/app.conf => "…"` | a file the script reads |
| `# @clock 2026-03-01T09:00:00Z` | what `date` reports |

After `=>` you can write `"text"`, `exit 22`, `"text" exit 22`, or `@path/to/file` for its contents.

### `◇!` — probably a bug

If the command that made the hole also used an **empty variable**, bashle marks it `◇!` and names
the variable instead of offering a fill:

```bash
api_url=${API_URL:-}           api_url=
curl -fsS "$api_url/health"    curl -fsS /health  ◇!1 $api_url was empty here
```

Filling this one would just hide the mistake. Fix the variable.

## More

- **[The bashle guide](docs/guide.md)**: every option, reading results, safety, troubleshooting
- [Using bashle in a real repository](docs/using-in-a-repository.md): `.bashleignore`, settings
- [How it works](docs/internals.md) · [A semantics for holes](docs/semantics.md) ·
  [Lean proofs](proofs/README.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT
