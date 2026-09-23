import Bashle.Syntax

/-!
# The v0 semantics

Definitions only.  The theorems live in `Bashle/Theorems.lean`.
-/

namespace Bashle

/-- `σ : Var ⇀ ŝ`.  An association list rather than a map: everything stays
    decidable and every proof is an induction on a list. -/
abbrev Env := List (Var × SStr)

/-- `Γ : Request ⇀ (Bytes × ℤ)`, the fills from `@net` / `@cmd` / `@file` /
    `@clock`.  The status is `Nat`, not `Int`: exit statuses are `0..255`, and
    `Nat` removes an impossible case from every proof. -/
abbrev Fills := List (Request × (Bytes × Nat))

/-- Look a variable up.  Unset expands to the empty string — bash without
    `set -u`, which v0 does not model.

    Written by structural recursion rather than `List.lookup` so that no `BEq`
    instance stands between a proof and its induction. -/
def lookupVar : Env → Var → SStr
  | [],           _ => []
  | (y, s) :: σ,  x => if x = y then s else lookupVar σ x

/-- Bind a variable by shadowing.  `lookupVar` reads the newest binding, so
    prepending is a complete implementation of assignment. -/
def setVar (σ : Env) (x : Var) (s : SStr) : Env := (x, s) :: σ

/-- `Γ(r)`. -/
def lookupFill : Fills → Request → Option (Bytes × Nat)
  | [],            _ => none
  | (r', v) :: Γ,  r => if r = r' then some v else lookupFill Γ r

/-- The `ι` already standing for `r`, if this run has met `r` before.

    This is what makes `ι` fresh per *request* rather than per invocation: two
    calls to the same URL find the same `ι` here and share it. -/
def elidedOf : Trace → Request → Option InputVar
  | [],                       _ => none
  | Interaction.elided r' ι :: τ, r => if r = r' then some ι else elidedOf τ r
  | _ :: τ,                   r => elidedOf τ r

/-- Expansion.  A *function*, not a relation: with no command substitution in
    milestone 1 it is total and deterministic, so a relation would buy nothing
    and cost every proof an extra induction.  It becomes a relation in M3. -/
def evalWord (σ : Env) : Word → SStr
  | .lit s     => s
  | .var x     => lookupVar σ x
  | .cat w₁ w₂ => evalWord σ w₁ ++ evalWord σ w₂
  | .quoted w  => evalWord σ w

/-- A configuration.

    There is no path condition `π`.  In v0 `OPEN` returns status `0`, never a
    symbolic status, so `IF-TRUE-SYM` can never fire and a `π` field would be
    provably always empty — which would read as if the semantics tracked
    something it does not.  `π` arrives with O2, in milestone 2. -/
structure Config where
  cmd    : Cmd
  env    : Env
  trace  : Trace
  status : Nat
  next   : InputVar
  deriving DecidableEq, Repr

/-- The small-step relation.

    `skip` plus a congruence rule for `;` is the textbook shape, and it is why
    `while` is purely additive later: one rule,
    `while c₁ do c₂ ↦ if c₁ then (c₂ ; while c₁ do c₂) else skip`, with no
    change to `Config`. -/
inductive Step (Γ : Fills) : Config → Config → Prop where
  /-- `Γ,σ ⊢ x := w ⇓ σ[x ↦ ŝ]`.  Assignment sets `$?` to 0. -/
  | assign {x w σ τ n k} :
      Step Γ ⟨.assign x w, σ, τ, n, k⟩
              ⟨.skip, setVar σ x (evalWord σ w), τ, 0, k⟩
  /-- Every external command is a request.

      A simplification: real bash runs plenty of commands bashle does not shim.
      Modelling those needs an oracle parameter that milestone 1 would use only
      to say "and then something happened".  Making FILL and OPEN the sole
      source of external behaviour is what makes the two claims below provable
      rather than merely stated. -/
  | exec {ws σ τ n k} :
      Step Γ ⟨.exec ws, σ, τ, n, k⟩ ⟨.req (ws.map (evalWord σ)), σ, τ, n, k⟩
  /-- FILL.  `Γ(r) = (b, n) ⟹ Γ ⊢ req(r) ⇓ (b, n) ; answered(r,b,n)` -/
  | fill {r b m σ τ n k} :
      lookupFill Γ r = some (b, m) →
      Step Γ ⟨.req r, σ, τ, n, k⟩
              ⟨.skip, σ, .answered r b m :: τ, m, k⟩
  /-- OPEN, first sighting of `r`.  `r ∉ dom Γ, ι fresh ⟹
      Γ ⊢ req(r) ⇓ (ι, 0) ; elided(r, ι)`

      The status is `0`, not symbolic.  That is what stops `set -e` ending the
      run, and it is the formal content of "evaluation does not get stuck on a
      hole".  It is also a deliberate lie — the real status is unknown.  See O2
      in `docs/semantics.md`. -/
  | openNew {r σ τ n k} :
      lookupFill Γ r = none → elidedOf τ r = none →
      Step Γ ⟨.req r, σ, τ, n, k⟩
              ⟨.skip, σ, .elided r k :: τ, 0, k + 1⟩
  /-- OPEN, `r` already seen.  `ι` is fresh per *request*, not per invocation:
      two calls to the same URL share one `ι`, because one fill answers both.
      The repeated trace entry is intentional — occurrences are tracked
      separately for display. -/
  | openOld {r ι σ τ n k} :
      lookupFill Γ r = none → elidedOf τ r = some ι →
      Step Γ ⟨.req r, σ, τ, n, k⟩
              ⟨.skip, σ, .elided r ι :: τ, 0, k⟩
  /-- Congruence: `c₁ ; c₂` steps by stepping `c₁`. -/
  | seqStep {c₁ c₁' c₂ σ σ' τ τ' n n' k k'} :
      Step Γ ⟨c₁, σ, τ, n, k⟩ ⟨c₁', σ', τ', n', k'⟩ →
      Step Γ ⟨.seq c₁ c₂, σ, τ, n, k⟩ ⟨.seq c₁' c₂, σ', τ', n', k'⟩
  | seqSkip {c₂ σ τ n k} :
      Step Γ ⟨.seq .skip c₂, σ, τ, n, k⟩ ⟨c₂, σ, τ, n, k⟩
  /-- Congruence: the condition of an `if` steps. -/
  | ifStep {c₁ c₁' c₂ c₃ σ σ' τ τ' n n' k k'} :
      Step Γ ⟨c₁, σ, τ, n, k⟩ ⟨c₁', σ', τ', n', k'⟩ →
      Step Γ ⟨.ifte c₁ c₂ c₃, σ, τ, n, k⟩ ⟨.ifte c₁' c₂ c₃, σ', τ', n', k'⟩
  /-- IF-TRUE-DET.  The status is always determinate in v0, so this and
      `ifFalse` are the only branch rules; IF-TRUE-SYM cannot fire. -/
  | ifTrue {c₂ c₃ σ τ k} :
      Step Γ ⟨.ifte .skip c₂ c₃, σ, τ, 0, k⟩ ⟨c₂, σ, τ, 0, k⟩
  | ifFalse {c₂ c₃ σ τ n k} :
      n ≠ 0 →
      Step Γ ⟨.ifte .skip c₂ c₃, σ, τ, n, k⟩ ⟨c₃, σ, τ, n, k⟩

/-- Reflexive-transitive closure.

    Defined here rather than imported: without Mathlib there is no
    `Relation.ReflTransGen`.  Five lines is a cheap price for zero
    dependencies. -/
inductive Star (Γ : Fills) : Config → Config → Prop where
  | refl {cfg} : Star Γ cfg cfg
  | tail {a b c} : Star Γ a b → Step Γ b c → Star Γ a c

/-- Exactly `n` steps.  `terminates` needs the count; `Star` alone loses it. -/
inductive StepN (Γ : Fills) : Nat → Config → Config → Prop where
  | zero {cfg} : StepN Γ 0 cfg cfg
  | succ {m a b c} : Step Γ a b → StepN Γ m b c → StepN Γ (m + 1) a c

/-- The executable form of `Step`.

    This exists so that one definition serves both jobs: `step?_iff` proves it
    equal to the relation, so the artifact that gets `#eval`'d and (in M6)
    differential-tested against real bash is the artifact the theorems are
    about — not a second opinion that has to be kept in sync by hand. -/
def step? (Γ : Fills) : Config → Option Config
  | ⟨.skip, _, _, _, _⟩ => none
  | ⟨.assign x w, σ, τ, _, k⟩ =>
      some ⟨.skip, setVar σ x (evalWord σ w), τ, 0, k⟩
  | ⟨.exec ws, σ, τ, n, k⟩ =>
      some ⟨.req (ws.map (evalWord σ)), σ, τ, n, k⟩
  | ⟨.req r, σ, τ, _, k⟩ =>
      match lookupFill Γ r with
      | some (b, m) => some ⟨.skip, σ, .answered r b m :: τ, m, k⟩
      | none =>
        match elidedOf τ r with
        | some ι => some ⟨.skip, σ, .elided r ι :: τ, 0, k⟩
        | none   => some ⟨.skip, σ, .elided r k :: τ, 0, k + 1⟩
  | ⟨.seq .skip c₂, σ, τ, n, k⟩ => some ⟨c₂, σ, τ, n, k⟩
  | ⟨.seq c₁ c₂, σ, τ, n, k⟩ =>
      (step? Γ ⟨c₁, σ, τ, n, k⟩).map fun cfg' => { cfg' with cmd := .seq cfg'.cmd c₂ }
  | ⟨.ifte .skip c₂ _, σ, τ, 0, k⟩ => some ⟨c₂, σ, τ, 0, k⟩
  | ⟨.ifte .skip _ c₃, σ, τ, n, k⟩ => some ⟨c₃, σ, τ, n, k⟩
  | ⟨.ifte c₁ c₂ c₃, σ, τ, n, k⟩ =>
      (step? Γ ⟨c₁, σ, τ, n, k⟩).map fun cfg' => { cfg' with cmd := .ifte cfg'.cmd c₂ c₃ }
  termination_by cfg => cfg.cmd

/-- A measure that every step strictly decreases.

    `exec` is 2 and `req` is 1 so that `Step.exec` decreases it.  `ifte` takes
    the max of its branches plus one, so `ifTrue` and `ifFalse` decrease it
    whichever branch is taken. -/
def size : Cmd → Nat
  | .skip        => 0
  | .assign _ _  => 1
  | .req _       => 1
  | .exec _      => 2
  | .seq c₁ c₂   => size c₁ + size c₂ + 1
  | .ifte c₁ c₂ c₃ => size c₁ + max (size c₂) (size c₃) + 1

/-- Iterate `step?` under fuel.

    Fuel rather than well-founded recursion on `size`, because `terminates` is
    itself one of the exercises and `run` must not depend on it. -/
def run (Γ : Fills) : Nat → Config → Config
  | 0,        cfg => cfg
  | fuel + 1, cfg =>
      match step? Γ cfg with
      | some cfg' => run Γ fuel cfg'
      | none      => cfg

/-- Run `c` from the empty configuration and keep the environment.

    `size c` is enough fuel: every step decreases `size` by at least one, and
    only `skip` has size zero. -/
def finalEnv (Γ : Fills) (c : Cmd) : Env :=
  (run Γ (size c) ⟨c, [], [], 0, 0⟩).env

/-- Substitute a value for one input variable. -/
def substAtom (ι : InputVar) (v : SStr) : Atom → SStr
  | .byte b => [.byte b]
  | .inp j  => if j = ι then v else [.inp j]

def substSStr (ι : InputVar) (v : SStr) (s : SStr) : SStr :=
  s.flatMap (substAtom ι v)

def substEnv (ι : InputVar) (v : SStr) (σ : Env) : Env :=
  σ.map fun p => (p.1, substSStr ι v p.2)

/-- A value is determinate when it contains no `ι`. -/
def determinate (s : SStr) : Bool :=
  s.all fun | .inp _ => false | .byte _ => true

/-- Every `ι` the trace has assigned to `r`.  `fresh_per_request` says this
    list never holds two different variables. -/
def elidedVars (τ : Trace) (r : Request) : List InputVar :=
  τ.filterMap fun
    | .elided r' ι => if r = r' then some ι else none
    | _            => none

end Bashle
