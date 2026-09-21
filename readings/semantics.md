# Reading for the holes semantics

Background for [`docs/superpowers/specs/2026-09-21-holes-semantics.md`](../docs/superpowers/specs/2026-09-21-holes-semantics.md).
Enough to write and critique that document — not a PL curriculum.

The ordering reflects one correction that reshaped the plan: **bashle's holes sit at the
I/O boundary, not inside the term.** The program is complete; only the environment's
answers are missing. That makes this symbolic execution with symbolic *inputs*, not an
incomplete-program calculus, so Hazel is demoted from blueprint to inspiration and the
shell-semantics literature matters more than it first appeared.

## Essential

**1 · Small-step operational semantics.**
Pierce, *Types and Programming Languages* — **chapter 3** (~20 pages). A tiny language,
judgments, reduction rules, induction over derivations. It is the exact template for how
the spec is written. Add **chapter 8** for progress and preservation: we have no types,
but the totality theorem (T1) is progress-shaped, so the proof technique is the one to
copy. Harper's *Practical Foundations for Programming Languages* ch. 1–5 covers the same
ground more austerely if you prefer it.

**2 · POSIX expansion order.**
Bash manual **§3.5**; IEEE 1003.1 XCU §2 for normative text. Brace → tilde →
parameter/arithmetic/command substitution → word splitting → pathname expansion → quote
removal.

**That order is most of the semantics.** Everything subtle about holes lives in it —
including why an unquoted hole has unknown *arity* and not merely unknown content.

**3 · Smoosh.**
Greenberg & Blatt, *Executable formal semantics for the POSIX shell*, OOPSLA 2020. An
executable, mechanized POSIX shell semantics tested against the conformance suite.

Read this before accepting the hand-written fragment in the spec. If Smoosh can be
extended, the work becomes "add one rule to an existing shell semantics" rather than
"invent a rival one" — far less to get wrong and a much stronger thing to cite. The spec
says as much in *What is modelled*; this is the item that decides it.

**4 · Symbolic execution.**
Cadar, Dunbar & Engler, *KLEE*, OSDI 2008. Read properly rather than skim, for one idea:
a run is valid only for inputs satisfying the **path condition** its branches imposed.

That concept is the spec's largest gap. bashle takes whichever branch bash happened to
take with a sentinel in place and records nothing about it.

## Hazel, demoted but not dropped

Omar, Voysey, Chugh & Hammer, *Live Functional Programming with Typed Holes*, POPL 2019 —
**§2 and §3 only**. Take the idea of an indeterminate result that evaluation carries
forward instead of getting stuck on. Leave the machinery: hole closures, indeterminate
*terms* and fill-and-resume-as-theorem all exist because Hazel's holes can be anywhere in
a term, and ours cannot.

The earlier Hazelnut (POPL 2017) is a structure-editor calculus. Skim for framing at most;
its edit actions, bidirectional typing and type consistency have no counterpart here.

## Other shell-semantics work

Worth an hour to know what exists before writing rules:

- **CoLiS** — Jeannerod, Marché & Treinen. A verified interpreter for a shell-like
  language, aimed at Debian maintainer scripts. Closest in spirit to formalizing a
  *fragment* deliberately.
- **ABASH** — Mazurak & Zdancewic, PLAS 2007. Static analysis of bash for injection bugs;
  useful for how they carve a tractable subset out of a hostile language.
- Greenberg also has an earlier, more readable piece on treating the POSIX shell as a
  programming language. *I am confident it exists but not of the venue — search rather
  than trust this citation.*

## If you intend to run the model

**PLT Redex** — Felleisen, Findler & Flatt, *Semantics Engineering with PLT Redex*. The
first few chapters plus the testing chapter, not the book.

The payoff is `redex-check`: **differential-test the semantics against real bash** on
hole-free programs, which validates the fragment before a single hole is involved. Days of
work for most of the value; mechanizing in Agda the way Hazelnut did is months.

## Read only to position the work

**Dynamic program slicing** — Agrawal & Horgan, PLDI 1990. Reach *is* a dynamic slice with
respect to the hole. Know the term so it does not get reinvented under a new name.

## Skip

Bidirectional typing, type consistency, the edit action calculus, abstract interpretation
proper, and string constraint solving — the last only becomes relevant if path conditions
are ever *solved* rather than reported.

## Five traps

More useful than the reading list. These are where intuition goes wrong.

**Two unrelated things are called "holes."** An evaluation context `E[·]` has a hole; a
Hazel term has a hole. Both will appear in the same document. A rule that conflates them
is wrong.

**Word splitting happens after expansion, so a hole has unknown arity.**

```bash
cp $files "$dest"      # files is an unfilled hole
```

Unquoted, it splits into an unknown *number* of words: the command's argv length is
indeterminate. The value domain `ŝ` cannot express that, and no sentinel scan will find
it. This is O1 in the spec, and the implementation silently treats it as one word.

**A command yields two results, not one.** A value *and* an exit status, each
independently indeterminate. Most calculi you will read have a single notion of result.

**The filesystem is a mutable store with path aliasing.** Once a path *name* is symbolic,
`[[ -f releases/x ]]` for a determinate `x` is unanswerable, because the unknown might
equal it. The store itself goes indeterminate. This is O3, and the deepest unmodelled part.

**`set -e`, `$?`, subshells and traps make bash non-compositional.** Read the bash manual
on `set -e` specifically — its real behaviour is a list of exceptions.

## Calibration

Before reading, write one sentence for each. Compare afterwards; where your answer changed
is where the formalism is earning its keep.

```bash
x=$(curl -s "$u"); echo "a$x" > "$x.txt"     # indeterminate name AND content
cp $files "$d"                                # unknown arity
if curl -f "$u"; then a=1; else a=2; fi       # a depends on the hole, contains no sentinel
(( x > 3 ))                                   # no answer in the current model
```

The last three are O1, the path-condition gap, and O2 — precisely where the spec is still
guessing.
