import Bashle

/-!
# Axiom audit

A theorem proved from another theorem that is still `sorry` emits no warning of
its own — it looks finished and the build stays green. `exact?` will produce
exactly that, because it searches every theorem in scope regardless of whether
its body has been filled in.

So counting `sorry` warnings is not enough. `#print axioms` sees through it:
anything resting on an unproved theorem, however indirectly, reports `sorryAx`.

CI requires the number of `sorryAx` lines below to equal `EXPECTED_SORRIES`.
Proving a theorem honestly removes one; proving it hollowly does not, so the
two counts disagree and the build fails.

Run it yourself with:  lake env lean Audit.lean
-/

open Bashle

-- Tier 1
#print axioms append_assoc_sstr
#print axioms skip_no_step
#print axioms open_steps
#print axioms status_zero_on_open

-- Tier 2
#print axioms progress
#print axioms determinism
#print axioms terminates

-- Tier 3
#print axioms fresh_per_request
#print axioms env_determinate
#print axioms reach_sound

-- Tier 4
#print axioms step?_iff
#print axioms fill_commutes
#print axioms reach_incomplete
