# The semantics, in Lean 4

A mechanization of [the v0 holes semantics](../docs/semantics.md): the rules as
a small-step relation, and the document's claims as theorems.

## Build

```bash
elan toolchain install $(cat lean-toolchain)   # first time only
lake build
```

No dependencies — not Mathlib, not Batteries. `lake build` needs no network
after the toolchain is installed.

## Layout

| | |
|---|---|
| `Bashle/Syntax.lean` | the grammar |
| `Bashle/Semantics.lean` | `Step`, and its executable twin `step?` |
| `Bashle/Theorems.lean` | every theorem, in four tiers; unproved bodies are `sorry` |
| `EXPECTED_SORRIES` | how many are still unproved — CI pins it |
| `Tests/Basic.lean` | `#guard` assertions over concrete programs |

## Working the exercises

`Bashle/Theorems.lean` is a workbook. Every statement is there; every body is
`sorry`. `lake build` prints one warning per remaining `sorry`, so the build
output is the progress bar:

```bash
# Lean v4.34 prints "declaration uses `sorry`" with backticks, so the pattern
# below matches either quoting — a straight-quoted one silently matches nothing.
lake build 2>&1 | grep 'declaration uses .sorry.'
```

Work top to bottom. The four tiers are the order you would actually develop
this in: each needs only the tiers above it, and the technique one tier teaches
is the technique the next assumes.

1. **Groundwork** — no induction. Find a library lemma; `cases` a hypothesis
   that cannot exist; produce a witness.
2. **Induction** — over a term, then over a derivation.
3. **Invariants** — induction over a run, where the statement is not strong
   enough to be its own induction hypothesis and you have to invent one.
4. **The hard ones** — mechanical grind, simulation, and a computation that
   fights the kernel.

When a proof lands, decrement `EXPECTED_SORRIES`. CI pins the count exactly, so
it catches a proof that regressed into `sorry` *and* a proof nobody counted.

Two warnings about `exact?`, which is the tactic you will reach for most. It
searches everything in scope, including theorems whose bodies are still
`sorry` — so it will cheerfully close a goal with the very theorem you are
trying to prove, or with another unproved one, and the build stays green while
you have proved nothing. If its suggestion names something from this file,
that is the tell. And a `sorry`-backed proof is only detectable afterwards with
`#print axioms <name>`, which lists `sorryAx` when the proof is hollow.

## What this does and does not establish

Lean checks that these rules are internally coherent. It does **not** check
that they describe bash — nothing here has ever run a shell. Validating the
fragment against the real thing is a later milestone, differential testing
`step?` against `bash` on determinate programs.
