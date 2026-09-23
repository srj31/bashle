import Bashle.Semantics

/-!
# The theorems

Statements first, proofs filled in as they are earned. Every body is `sorry`
until it is proved; `lake build` prints one warning per remaining one, so the
build output is the progress bar and `EXPECTED_SORRIES` is the target.

The order is the order you would actually develop this in — each tier needs
only the tiers above it, and the technique each one teaches is the technique
the next one assumes.

  1. **Groundwork** — no induction. Finding a library lemma; `cases` on a
     hypothesis that cannot exist; producing a witness for an existential.
  2. **Induction** — over a term, then over a derivation. The first proofs
     where the induction hypothesis is doing the work.
  3. **Invariants** — induction over a *run*, where the thing you induct on is
     not the thing you want, so you have to invent the statement that is
     strong enough to carry itself.
  4. **The hard ones** — mechanical grind (`step?_iff`), simulation between
     two runs (`fill_commutes`), and a computation that fights the kernel
     (`reach_incomplete`).
-/

namespace Bashle

/-! ## Tier 1 — groundwork

No induction anywhere in this tier. -/

/-- Concatenation of symbolic strings is associative.

    Hint: `SStr` is `List Atom` and `++` is `List.append`, so this is a library
    lemma.  One line.  It is here to confirm the domain really is the free
    monoid the document claims. -/
theorem append_assoc_sstr (s₁ s₂ s₃ : SStr) :
    (s₁ ++ s₂) ++ s₃ = s₁ ++ (s₂ ++ s₃) := by
  sorry

/-- `skip` is terminal.

    Hint: `intro h; cases h` — there is no constructor of `Step` whose source
    command is `skip`, so the `cases` closes every goal.  `determinism` needs
    this to rule out `seqStep` against `seqSkip`. -/
theorem skip_no_step {Γ : Fills} {σ τ n k} {cfg' : Config} :
    ¬ Step Γ ⟨.skip, σ, τ, n, k⟩ cfg' := by
  sorry

/-- The corollary that names the promise: a request with no fill still steps.

    Hint: `cases` on `elidedOf τ r` and apply `openNew` or `openOld`. -/
theorem open_steps {Γ : Fills} {r : Request} {σ τ n k}
    (h : lookupFill Γ r = none) :
    ∃ cfg', Step Γ ⟨.req r, σ, τ, n, k⟩ cfg' := by
  sorry

/-- OPEN leaves the status at 0.

    This is the `set -e` claim, made checkable.  Hint: `cases` on the step; the
    `fill` case contradicts `h` by `simp_all`. -/
theorem status_zero_on_open {Γ : Fills} {r : Request} {σ τ n k} {cfg' : Config}
    (h : lookupFill Γ r = none) (hs : Step Γ ⟨.req r, σ, τ, n, k⟩ cfg') :
    cfg'.status = 0 := by
  sorry


/-! ## Tier 2 — induction

`progress` inducts over a *term* (`Cmd`); `determinism` inducts over a
*derivation* (`Step`). Those are different enough to be worth feeling
separately. `terminates` wants a helper lemma you have to spot yourself. -/

/-- **T1, progress.**  Evaluation never gets stuck.

    Hint: induction on `cfg.cmd`.  `seq` and `ifte` need the induction
    hypothesis, and each splits on whether the left component is already
    `skip`.

    The `req` case *is* the theorem.  `lookupFill Γ r` is either `some`, giving
    `fill`, or `none`, in which case `elidedOf τ r` decides between `openNew`
    and `openOld` — and crucially there is no fourth possibility where the
    request has no rule.  That is what "an unanswered request never aborts a
    run" means formally. -/
theorem progress {Γ : Fills} (cfg : Config) (h : cfg.cmd ≠ .skip) :
    ∃ cfg', Step Γ cfg cfg' := by
  sorry

/-- The relation is a function.

    Hint: `induction h₁ generalizing b`, then `cases h₂` inside each case.
    Induction rather than `cases`: the `seqStep`/`seqStep` pair leaves the two
    inner configurations to be identified, and that sub-goal *is* this theorem,
    so only the induction hypothesis closes it — `ifStep`/`ifStep` likewise.
    Generalizing `b` is what lets the hypothesis apply to the second step.

    Within the cases, `simp_all` does the rest: the `req` cases need that
    `lookupFill` and `elidedOf` each return one answer, and the congruence
    cases against `seqSkip`/`ifTrue`/`ifFalse` need `skip_no_step`.

    Note what makes this true: freshness comes from the `next` counter in the
    configuration, not from a side condition picking an arbitrary unused name.
    A `ι fresh` premise would have made the relation non-deterministic. -/
theorem determinism {Γ : Fills} {cfg a b : Config}
    (h₁ : Step Γ cfg a) (h₂ : Step Γ cfg b) : a = b := by
  sorry

/-- Every run reaches `skip`.

    Hint: the natural first instinct — strong induction on `size cfg.cmd` — is
    not available here.  `Nat.strong_induction_on` is a Mathlib name and this
    project has no Mathlib; core's `Nat.strongRecOn` exists but drags a motive
    through the `generalize` you would need.  Count down a bound instead:
    ordinary induction on `s` in an auxiliary `∀ s cfg, size cfg.cmd ≤ s → …`,
    which is the same argument with no library surface at all.

    Either way, prove first that every step strictly decreases `size`;
    `progress` supplies the step.

    This is provable only because milestone 1 has no loops.  It dies in M2, and
    that is the point at which `progress` starts carrying the weight on its
    own. -/
theorem terminates {Γ : Fills} (cfg : Config) :
    ∃ m σ τ n k, StepN Γ m cfg ⟨.skip, σ, τ, n, k⟩ := by
  sorry


/-! ## Tier 3 — invariants

Both proofs here induct over a `Star` run. Neither statement is strong enough
to be its own induction hypothesis, so each needs an invariant invented for it
— that invention is the whole skill this tier teaches. -/

/-- **`ι` is fresh per request, not per invocation.**

    Two calls to the same URL share one `ι`, because one fill answers both.

    Hint: induction on the `Star` derivation.  The invariant to carry is that
    `elidedVars τ r` is either empty or constant, and that `openOld` is the only
    rule that can extend a non-empty one. -/
theorem fresh_per_request {Γ : Fills} {c : Cmd} {σ τ n k}
    (h : Star Γ ⟨c, [], [], 0, 0⟩ ⟨.skip, σ, τ, n, k⟩)
    (r : Request) {ι₁ ι₂ : InputVar}
    (h₁ : ι₁ ∈ elidedVars τ r) (h₂ : ι₂ ∈ elidedVars τ r) :
    ι₁ = ι₂ := by
  sorry

/-- Determinate literals inside a word: no `ι` written straight into the
    source text.

    `Word.lit` accepts a symbolic `SStr`, which the source grammar never
    produces on its own — `litsDeterminate` and `env_determinate` below exist
    only to rule that possibility back out. -/
def wordLitsDeterminate : Word → Prop
  | .lit s     => determinate s = true
  | .var _     => True
  | .cat w₁ w₂ => wordLitsDeterminate w₁ ∧ wordLitsDeterminate w₂
  | .quoted w  => wordLitsDeterminate w

/-- A program whose literals are all determinate — no `ι` written into the
    source text.  Every program a user could actually write satisfies this;
    `Word.lit` merely happens to accept a symbolic `SStr` as well. -/
def litsDeterminate : Cmd → Prop
  | .skip          => True
  | .assign _ w    => wordLitsDeterminate w
  | .exec ws       => ∀ w ∈ ws, wordLitsDeterminate w
  | .seq c₁ c₂     => litsDeterminate c₁ ∧ litsDeterminate c₂
  | .ifte c₁ c₂ c₃ => litsDeterminate c₁ ∧ litsDeterminate c₂ ∧ litsDeterminate c₃
  | .req _         => True

/-- No hole's value ever reaches a variable in milestone 1.

    `Env` is written only by `assign`, through `evalWord`, which can produce
    nothing but program literals and existing `Env` values — the request rules
    write `trace` and `status` and never touch `env`.  So with determinate
    literals, every variable stays determinate.

    Hint: induction on the `Star` derivation, carrying "every value in `σ` is
    determinate" as the invariant.  The `assign` case needs the corresponding
    fact about `evalWord`. -/
theorem env_determinate {Γ : Fills} {c : Cmd} {σ τ n k}
    (hdet : litsDeterminate c)
    (h : Star Γ ⟨c, [], [], 0, 0⟩ ⟨.skip, σ, τ, n, k⟩) (x : Var) :
    determinate (lookupVar σ x) = true := by
  sorry

/-- **T2, reach soundness.**  If `ι` survives into `σ(x)`, then `x` genuinely
    depends on the request `ι` stands for: two different fills drive `x` to two
    different values.

    Stated over `finalEnv` rather than `Star` so that the two runs being
    compared are the same run under different fills, which is the content of
    "depends on".

    The `litsDeterminate` hypothesis rules out a shape `Word.lit` technically
    allows but no user program produces: a literal whose `SStr` already
    contains an `ι`, written straight into the source rather than arriving
    from a request.  Without it the theorem is false, not merely awkward —
    `.assign "x" (.lit [Atom.inp 0])` after an `openNew` on some unrelated
    request satisfies every other hypothesis while assigning the very same
    literal under every fill, so the two runs never differ.

    In milestone 1 this theorem holds only **vacuously**: `env_determinate`
    shows that with `litsDeterminate` in force, `hx` can never be satisfied,
    because no request rule ever writes into `env`.  That is not a defect in
    the statement but a fact about the fragment — T2 acquires actual content
    only once command substitution lets a request's output flow into a
    variable, which is out of scope until a later milestone.

    Hint: `env_determinate` and `hdet` together contradict `hx` outright, so
    the existential can be discharged from `False`.  Provable in M1 only
    vacuously, via `env_determinate`. -/
theorem reach_sound {Γ : Fills} {c : Cmd} {r : Request} {ι : InputVar}
    {x : Var} {σ τ n k}
    (hdet : litsDeterminate c)
    (h : Star Γ ⟨c, [], [], 0, 0⟩ ⟨.skip, σ, τ, n, k⟩)
    (hr : Interaction.elided r ι ∈ τ)
    (hΓ : lookupFill Γ r = none)
    (hx : Atom.inp ι ∈ lookupVar σ x) :
    ∃ v₁ v₂ : Bytes,
      lookupVar (finalEnv ((r, (v₁, 0)) :: Γ) c) x
        ≠ lookupVar (finalEnv ((r, (v₂, 0)) :: Γ) c) x := by
  sorry


/-! ## Tier 4 — the hard ones

Leave these until the rest are done. Each is hard for a different reason. -/

/-- The executable form agrees with the relation.

    Hint: `constructor`, and do not reach for `simp [step?]` — `step?` is a
    `match` with shadowed patterns (`.seq .skip _` before `.seq _ _`, likewise
    for `.ifte`), so Lean gives it *conditional* equation lemmas, and unfolding
    with a bare `simp` or a `cases` on the resulting `Option` is not a route
    that closes.  Use the equation lemmas directly, by name, with each side
    condition discharged: `rw [step?.eq_N]` for the unshadowed rule that
    matches, and `skip_no_step` to produce the `c₁ ≠ .skip` that the `seq`/`ifte`
    congruence lemmas need before they fire.  `step?.eq_9` (the general `ifte`
    branch) carries two such side conditions, not one.

    Forward (`Step → step?`): induction on the derivation; every rule but the
    two congruence ones is exactly one `rw`.  Backward (`step? → Step`):
    induction on `cfg.cmd`, generalizing the rest of the configuration, case on
    whether the left component of `seq`/`ifte` is already `.skip`, and read the
    successor off the rewritten equation.

    This is the lemma that keeps one definition instead of two, and it is what
    M6 (differential testing against real bash) stands on. -/
theorem step?_iff {Γ : Fills} {cfg cfg' : Config} :
    step? Γ cfg = some cfg' ↔ Step Γ cfg cfg' := by
  sorry

/-- **T3, fill commutation.**  Filling and then running agrees with running and
    then substituting.

    In v0 there is no proviso: the path condition is vacuous because OPEN's
    status is always 0, so no branch is ever decided by an unfilled hole in a
    way that `π` would have had to record.  The proviso returns in M2.

    Stated on the environment only.  Under a fill the trace records `answered`
    where it previously recorded `elided`, so the two configurations are not
    equal; the environments are, after substituting `ι`.

    The `litsDeterminate` hypothesis exists only because `Word.lit` accepts a
    symbolic `SStr`.  A program can therefore write an `ι` straight into its
    source text, and no fill can change a literal, so without `hdet` the
    statement is false rather than merely awkward: for
    `.seq (.exec [.lit (strS "curl")]) (.assign "x" (.lit [Atom.inp 0]))` every
    other hypothesis holds while the filled run still assigns the bare `ι` and
    the substituted run assigns the fill's bytes.

    In milestone 1 the theorem then holds for a reason narrower than its name
    suggests.  No request rule touches `env` — only `assign` writes it — and a
    fill of status `0` drives exactly the same branches as `OPEN`, whose status
    is also `0`.  So the filled and the unfilled run reach the very same
    environment, and with determinate literals `substEnv` is the identity on
    it.  T3 acquires its intended content once command substitution lets a
    request's output reach a variable.

    T3 is what makes the `◇1` annotations honest: without it, `dest=releases/◇1`
    is not a claim about what any fill would do.

    Hint: show the two runs agree on command, environment and status at every
    step — the trace and the fresh-variable counter are where they genuinely
    differ — and then that `substEnv` does nothing to a determinate
    environment. -/
theorem fill_commutes {Γ : Fills} {c : Cmd} {r : Request} {ι : InputVar}
    {v : Bytes} {σ τ n k}
    (hdet : litsDeterminate c)
    (h : Star Γ ⟨c, [], [], 0, 0⟩ ⟨.skip, σ, τ, n, k⟩)
    (hr : Interaction.elided r ι ∈ τ)
    (hΓ : lookupFill Γ r = none) :
    finalEnv ((r, (v, 0)) :: Γ) c = substEnv ι (toSStr v) (finalEnv Γ c) := by
  sorry

/-- The request made by `counterexample`. -/
def curlReq : Request := [strS "curl", strS "-f", strS "u"]

/-- `if curl -f u; then x=a; else x=b; fi`

    The program from `docs/semantics.md`: `x` depends on the hole while
    containing no occurrence of it. -/
def counterexample : Cmd :=
  .ifte (.exec [.lit (strS "curl"), .lit (strS "-f"), .lit (strS "u")])
        (.assign "x" (.lit (strS "a")))
        (.assign "x" (.lit (strS "b")))

/-- **T2′, reach incompleteness.**  The converse of T2 fails.

    `x` is fully determinate — no `ι` anywhere in it — and yet two fills give
    two different values.  Reach tracks *data* dependence; `π` tracks *control*
    dependence; the tool has only the former.

    This is a counterexample, not a conjecture, so it is a computation.

    Hint: try `decide`, but do not expect it to close the goal by itself.
    `step?` is compiled through well-founded recursion
    (`termination_by cfg => cfg.cmd`), and kernel reduction — which is what
    `decide` uses — characteristically gets stuck unfolding a well-founded
    definition even when the compiled code (`#eval`) reduces it fine; that is
    exactly why the `#eval` check in the brief succeeded and tells you nothing
    about whether `decide` will.  `native_decide` is banned outright by this
    project's global constraints, with no exception here, so it is not an
    available fallback.  If `decide` stalls, unfold through the equation
    lemmas instead — `simp [counterexample, curlReq, finalEnv, run, step?,
    size, lookupFill, elidedOf, evalWord, setVar, lookupVar, determinate]`.

    Expect a second, less obvious wall once the run itself unfolds.  `strS`
    goes through `String.toUTF8`, and the kernel reduces a string literal to
    its *characters*, never to its bytes — so `strS "a" ≠ strS "b"`, the very
    inequality the counterexample turns on, does not fall out.  Budget for it:
    route the literal through `String.ofList` so its bytes become
    `List.utf8Encode`, supplying `s.toList = [c]` and `String.utf8EncodeChar c
    = [b]` by `decide`, and unfold `ByteArray.toList`'s own well-founded loop
    on the resulting one-element array.  Two small lemmas, proved once and
    passed to the `simp` above as `strS "a" = [Atom.byte 97]` and
    `strS "b" = [Atom.byte 98]`. -/
theorem reach_incomplete :
    determinate (lookupVar (finalEnv [] counterexample) "x") = true
    ∧ lookupVar (finalEnv [(curlReq, ([], 0))] counterexample) "x"
        ≠ lookupVar (finalEnv [(curlReq, ([], 1))] counterexample) "x" := by
  sorry

end Bashle
