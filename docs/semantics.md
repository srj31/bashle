# A semantics for holes (v0)

Companion to [the reading notes](../readings/semantics.md).

**Status: v0, deliberately partial.** Every section is marked *settled*, *stated* or
*open*. Nothing here is proven. The point of v0 is to make the guesses in the
implementation visible and nameable, not to be complete.

## The one idea

A bashle run is an **open program**: closed in its code, open in its inputs. The script
is complete — unlike Hazel, there is never a missing subexpression. What is missing is
the environment's half of the conversation.

So the meaning of a run is a function of the fills it was given:

```
⟦c⟧ : (Request ⇀ Response) → (Trace × State × PathCondition)
```

Each unanswered request becomes a fresh symbolic variable. This is symbolic execution
with symbolic *inputs only*, not an incomplete-program calculus. *(settled)*

## What is modelled

The fragment bashle claims to handle: assignments, simple commands, sequencing,
`if`/`while`/`for`, functions, parameter expansion, command substitution, word
splitting, redirection, exit status.

Not modelled in v0: `case`, arrays, arithmetic expansion, subshell scoping, `trap`,
pipelines as anything other than one opaque command, globbing, process substitution.

**This should not stay hand-written.** Smoosh (Greenberg & Blatt, OOPSLA 2020) is an
executable POSIX shell semantics tested against the conformance suite. The intended
end state is *their* semantics plus the one rule below, not a rival shell semantics.
The grammar here exists so v0 can be discussed at all. *(open — see Next)*

Why this is not Hazel: Hazel's holes can sit anywhere in a term, which is what forces
hole closures, indeterminate *terms* and fill-and-resume as a theorem. Ours sit at the
I/O boundary only — the script is complete, and just its inputs are missing — so all of
that machinery falls away and what remains is the one rule pair below.

## Domains

```
b  ∈ Bytes
ι  ∈ InputVar                fresh per unanswered request

ŝ  ::= ε | b·ŝ | ι·ŝ         symbolic string: free monoid over bytes and inputs
n̂  ::= n | ι                 symbolic exit status
σ  : Var ⇀ ŝ                 variable environment
φ  : ŝ ⇀ ŝ                   filesystem, keyed by a possibly-symbolic path
τ  ::= list of Interaction   trace
π  ::= list of Constraint    path condition
Γ  : Request ⇀ (Bytes × ℤ)   the fills, from @net / @cmd / @file / @clock
```

`Interaction ::= answered(r, b, n) | elided(r, ι)`. The second is the "external output
that never happened" case: `systemctl restart nginx` as a hole produces no value worth
having, but the fact that an effect was skipped is part of the run's meaning. *(settled)*

A **determinate** value is one containing no `ι`.

## Syntax

```
w ::= lit b | var x | w · w | sub c | quoted w | unquoted w
c ::= x := w | exec w⃗ | c ; c | if c then c else c | while c do c
    | for x in w⃗ do c | c > w | fun f c | call f w⃗
```

`req(r)` is not surface syntax. It is what `exec w⃗` reduces to when the command word
names a shimmed program; `r` is the normalized request. *(settled)*

## The rule that matters

```
        Γ(r) = (b, n)                              r ∉ dom(Γ)      ι fresh
──────────────────────────────── FILL      ──────────────────────────────────── OPEN
Γ ⊢ req(r) ⇓ (b, n) ; answered(r,b,n)      Γ ⊢ req(r) ⇓ (ι, 0) ; elided(r, ι)
```

Two things are load-bearing in OPEN.

**The status is 0, not symbolic.** That is what stops `set -e` ending the run, and it
is the formal content of "evaluation does not get stuck on a hole". It is also a
deliberate lie: the real status is unknown. v0 tells the lie and records it; see
*Open decisions*. *(settled, and known to be an approximation)*

**`ι` is fresh per request, not per invocation.** Two calls to the same URL share one
`ι`, because one fill answers both. Occurrences are tracked separately for display
only. *(settled)*

## Expansion, briefly

Expansion is where symbolic values actually spread, and the order is POSIX's:

```
Γ,σ ⊢ var x ⇓ σ(x)          Γ,σ ⊢ w₁·w₂ ⇓ ŝ₁ŝ₂          Γ,σ ⊢ sub c ⇓ ŝ  (stdout of c)
```

Concatenation of symbolic strings is concatenation in the monoid — which is exactly why
the implementation's sentinel works without any cooperation from bash: `ŝ₁ŝ₂` is what
the shell does anyway. *(settled)*

Word splitting is **not** defined in v0. See *Open decisions*.

## Path conditions

At every branch, the constraint the taken branch imposed on the inputs is recorded:

```
Γ,σ ⊢ c₁ ⇓ …, n̂, …      n̂ determinate, n̂ = 0
──────────────────────────────────────────────── IF-TRUE-DET
Γ ⊢ if c₁ then c₂ else c₃ ⇓ … π unchanged …
```

```
Γ,σ ⊢ c₁ ⇓ …, n̂, …      n̂ indeterminate, branch taken = true
──────────────────────────────────────────────────────────── IF-TRUE-SYM
Γ ⊢ if c₁ then c₂ else c₃ ⇓ … π, (n̂ = 0) …
```

A run with `π = []` is **path-independent**: its result holds for every fill. A run with
a non-empty `π` holds only for fills satisfying it, and saying so is the honest version
of "this branch was decided by an unfilled hole".

**The implementation records no path condition at all.** It takes whichever branch bash
happened to take with a sentinel in place and says nothing. This is the largest single
gap between the tool and this document. *(stated; unimplemented)*

## Theorems, as claims

**T1 — Totality.** For all `c` and `Γ`, evaluation does not get stuck. An unanswered
request never aborts a run. *(stated; this is the design's core promise and the easiest
to test in Redex before proving)*

**T2 — Reach soundness.** If `ι ∈ ŝ` for some value `ŝ` in the final state, then that
value depends on `ι`: there exist two fills yielding different values. *(stated)*

**T2′ — Reach incompleteness.** The converse fails. `if curl -f u; then x=a; else x=b; fi`
makes `x` depend on `ι` while containing no occurrence of it. Reach tracks *data*
dependence; `π` tracks *control* dependence; the tool has only the former. *(settled —
this is a counterexample, not a conjecture)*

**T3 — Fill commutation.** For a fill `θ = [ι ↦ v]`:

```
⟦c⟧(Γ ⊎ {r ↦ v})  =  θ(⟦c⟧(Γ))      provided π is satisfied by θ
```

Filling and then running agrees with running and then substituting — exactly when the
path condition holds. T3 is what makes the `◇1` annotations *honest*: without it,
`dest=releases/◇1` is not a claim about what any fill would do. *(stated)*

## Open decisions

The three the formalism forces, none of which are Hazel's fault — they are bash's.

**O1 — Unknown arity.** `cp $files "$d"` unquoted splits a symbolic value into an
unknown *number* of words. The domain `ŝ` cannot express that; a symbolic *sequence* is
needed, or unquoted expansion of a symbolic value must be declared an indeterminate
command. The implementation does neither and will silently treat it as one word.

**O2 — Symbolic status.** OPEN returns 0 because that keeps the run alive. The truthful
rule returns `ι`, which immediately requires IF-TRUE-SYM above and a story for `(( ))`,
where a symbolic operand has no numeric meaning at all. The implementation reports the
arithmetic case as a diagnostic precisely because it has no semantics for it.

**O3 — Symbolic paths.** `mkdir -p releases/ι` makes `φ` keyed by a symbolic path, after
which `[[ -f releases/x ]]` for determinate `x` is unanswerable, because `ι` might equal
`x`. Wholly unmodelled in the tool.

## Correspondence to the code

| Formal object | Implementation |
|---|---|
| `ι` | the sentinel `\x01h<token>\x01` (`src/shims.ts`) |
| fresh-per-request | grouping by request in `assembleHoles` (`src/holes.ts`) |
| `Γ` | `Fill[]`, compiled into shim branches |
| FILL / OPEN | the two exits of a generated shim |
| status 0 in OPEN | `exit 0` in the shim — what survives `set -e` |
| `ŝ₁ŝ₂` | bash's own concatenation; no code needed |
| `ι ∈ ŝ` | `reaches`, by substring scan |
| `elided(r, ι)` | an `H` record with state `open` |
| `π` | **nothing** |

That last row is the summary of this document.

## Next

1. Read Smoosh and decide whether the fragment above is replaced by it. Prefer replaced.
2. Encode v0 in PLT Redex and use `redex-check` to differential-test against real bash
   on *determinate* programs — that validates the fragment before any hole is involved.
3. Test T1 by random generation before attempting a proof.
4. Decide O2, since O1 and O3 both get easier once statuses can be symbolic.
5. Only then consider mechanization. Redex first is the cheap 80%.
