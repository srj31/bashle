# A semantics for holes (v0)

Companion to [the reading notes](../readings/semantics.md).

**Status: v0, deliberately partial.** Every section is marked *settled*, *stated* or
*open*. The prose here proves nothing; the Lean development in `proofs/` proves the
theorems it states — not that they describe bash. The point of v0 is to make the
guesses in the implementation visible and nameable, not to be complete.

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
request never aborts a run. *(stated in Lean as `progress`)*

**T2 — Reach soundness.** If `ι ∈ ŝ` for some value `ŝ` in the final state, then that
value depends on `ι`: there exist two fills yielding different values. *(stated in Lean
as `reach_sound`; vacuous in milestone 1 — see Mechanization)*

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
`dest=releases/◇1` is not a claim about what any fill would do. *(stated in Lean as `fill_commutes`)*

Each of these is now a Lean statement in
[`proofs/Bashle/Theorems.lean`](../proofs/Bashle/Theorems.lean): `progress` and
`open_steps` for T1, `reach_sound` for T2, `reach_incomplete` for T2′, and
`fill_commutes` for T3. The file is a workbook: the thirteen are arranged in
four tiers, simplest first, and each body stays `sorry` until it is proved.
`proofs/EXPECTED_SORRIES` records how many are outstanding and CI pins it, so
the count cannot drift. T2′ is a computation over the concrete counterexample
rather than an argument — though `decide` alone stalls on `step?`'s
well-founded recursion.

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
| `π` | **nothing** — and absent from the Lean model too, by decision, not oversight |

That last row is the summary of this document.

## Mechanization

The rules above are formalized in Lean 4 in [`proofs/`](../proofs/), as a
small-step relation `Step` rather than the big-step `⇓` written here. The
translation is deliberate: T1 says evaluation does not get *stuck*, and big-step
cannot distinguish getting stuck from running forever, so the theorem is not
even statable in the notation this document uses.

`reach_sound` (T2) needed a correction along the way: as first stated it was
false, because `Word.lit` accepts a symbolic string — a program can write an
`ι` straight into its source text, and no fill changes a literal. The fix adds
a `litsDeterminate` hypothesis, ruling that shape out, and a new lemma,
`env_determinate`, that `reach_sound` leans on. `fill_commutes` (T3) needed the
same hypothesis for the same reason.

**T2 holds only vacuously in milestone 1.** `Env` is written by `assign` alone,
through `evalWord`; no request rule touches it. The one mechanism that would
carry a request's output into a variable — command substitution — is out of
milestone-1 scope. So no hole's value can ever reach a variable, `reach_sound`'s
hypothesis is never satisfiable, and `env_determinate` is what proves that. This
is a fact about the fragment, not a defect in the statement: T2 acquires actual
content once command substitution lands.

**T3 is satisfiable, but thin.** Unlike `reach_sound`'s, `fill_commutes`'s
hypotheses can be met, and the proof rests on real forward simulation
(`step_agrees`, `finalEnv_fill`): a status-0 fill for an unanswered request is
shown, step for step, to change nothing but the trace and the fresh-variable
counter. That is also the limit of its milestone-1 content — both sides of the
conclusion rewrite to the same `finalEnv Γ c`, because the fill changes nothing
and the substitution then has nothing to do. Like T2, T3 acquires its intended
content once command substitution lands.

Two things the Lean model does not carry:

- **No path condition.** `π` is absent from `Config`, not modelled as empty. In
  v0 `OPEN` returns status `0`, never a symbolic status, so `IF-TRUE-SYM` can
  never fire and a `π` field would be provably always `[]` — which would read as
  if the semantics tracked control dependence. It arrives with O2.
- **Every external command is a request.** `exec w⃗` reduces to `req r`
  unconditionally, so `FILL` and `OPEN` are the only source of external
  behaviour. Real bash runs plenty of commands bashle does not shim; modelling
  those needs an oracle the bare core would never consult.

**What this establishes, and what it does not.** Lean checks that these rules
are internally coherent. It does not check that they describe bash — nothing in
`proofs/` has ever run a shell. A semantics can be perfectly consistent and
still be wrong about the thing it models, and closing that gap is a separate
piece of work, below. That limitation matters more now that the theorems are
actually proved, not less.

## Next

The original plan here put PLT Redex first and mechanization last. That has been
inverted, for one reason: Redex's payoff is `redex-check`, differential-testing
the rules against real bash — and Lean can do that too, now that the executable
`step?` is proved equal to the relation `Step` (`step?_iff`). Doing it in Lean
means one definition instead of two, where a Redex model and a Lean model would
have to be kept in step by hand with nothing checking that they were.

The milestone-1 rules are settled; the thirteen theorems stated over them are
being proved a tier at a time. What is left:

1. Decide O2. Symbolic exit status is the keystone: `π` and `IF-TRUE-SYM` both
   become real the moment it lands, and O1 and O3 both get easier.
2. Extend the fragment — `while`, then command substitution and functions, then
   the store. Command substitution is also what gives `reach_sound` its first
   non-vacuous case.
3. Differential-test `step?` against real bash on determinate programs. This is
   what validates the fragment, and until it exists the mechanization is a
   consistency check and nothing more.
4. Read Smoosh and decide whether the fragment is replaced by it. Still prefer
   replaced: adding one rule to an existing POSIX semantics is a far stronger
   thing to cite than a rival fragment, however well mechanized.
5. Word splitting last. O1 may force the value domain to change from symbolic
   strings to symbolic *sequences*, which invalidates the domain rather than
   extending it.
