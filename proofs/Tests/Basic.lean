import Bashle

open Bashle

-- Bytes inject into symbolic strings as `byte` atoms and nothing else.
#guard toSStr [65, 66] == [Atom.byte 65, Atom.byte 66]

-- `strS` is the readable spelling used throughout the tests.
#guard strS "AB" == [Atom.byte 65, Atom.byte 66]

-- Concatenation of symbolic strings is list append; nothing else is needed.
#guard strS "a" ++ [Atom.inp 0] ++ strS "b"
         == [Atom.byte 97, Atom.inp 0, Atom.byte 98]

-- Decidable equality reaches inside every layer.
#guard (Cmd.assign "x" (.lit (strS "a")) == Cmd.assign "x" (.lit (strS "a")))
#guard !(Cmd.assign "x" (.lit (strS "a")) == Cmd.assign "y" (.lit (strS "a")))

-- An unset variable expands to the empty string.  This is bash *without*
-- `set -u`; v0 does not model `set -u`.
#guard evalWord [] (.var "nope") == ([] : SStr)

-- `setVar` shadows by prepending, so the newest binding wins.
#guard lookupVar (setVar (setVar [] "x" (strS "old")) "x" (strS "new")) "x"
         == strS "new"

#guard evalWord [("x", strS "hi")] (.var "x") == strS "hi"

-- Concatenation in the monoid, with a symbolic atom in the middle.
#guard evalWord [("x", [Atom.inp 7])]
         (.cat (.lit (strS "a")) (.cat (.var "x") (.lit (strS "b"))))
       == [Atom.byte 97, Atom.inp 7, Atom.byte 98]

-- `quoted` is the identity in v0.
#guard evalWord [("x", strS "a b")] (.quoted (.var "x"))
       == evalWord [("x", strS "a b")] (.var "x")

-- Lookups miss cleanly.
#guard lookupFill [] ([strS "curl"]) == none
#guard lookupFill [([strS "curl"], ([65], 0))] [strS "curl"] == some ([65], 0)
#guard elidedOf [] [strS "curl"] == none
#guard elidedOf [Interaction.elided [strS "curl"] 3] [strS "curl"] == some 3
#guard elidedOf [Interaction.answered [strS "curl"] [] 0] [strS "curl"] == none

-- OPEN fires when there is no fill, and leaves the status at 0.  That zero is
-- what stops `set -e` ending the run.
example :
    Step [] ⟨.req [strS "curl"], [], [], 9, 0⟩
            ⟨.skip, [], [Interaction.elided [strS "curl"] 0], 0, 1⟩ :=
  Step.openNew (by decide) (by decide)

-- A second request to the same `r` reuses the same `ι` and does not bump the
-- counter: fresh per request, not per invocation.
example :
    Step [] ⟨.req [strS "curl"], [], [Interaction.elided [strS "curl"] 0], 0, 1⟩
            ⟨.skip, [], [Interaction.elided [strS "curl"] 0,
                         Interaction.elided [strS "curl"] 0], 0, 1⟩ :=
  Step.openOld (by decide) (by simp [elidedOf])

-- FILL fires when Γ answers, and propagates the fill's status.
example :
    Step [([strS "curl"], ([65], 7))] ⟨.req [strS "curl"], [], [], 0, 0⟩
            ⟨.skip, [], [Interaction.answered [strS "curl"] [65] 7], 7, 0⟩ :=
  Step.fill (by simp [lookupFill])

-- `exec` reduces to a request, expanding its words on the way.
example :
    Step [] ⟨.exec [.var "cmd"], [("cmd", strS "curl")], [], 0, 0⟩
            ⟨.req [strS "curl"], [("cmd", strS "curl")], [], 0, 0⟩ :=
  Step.exec

-- `x=a` in one step, and then it is done.
#guard step? [] ⟨.assign "x" (.lit (strS "a")), [], [], 0, 0⟩
       == some ⟨.skip, [("x", strS "a")], [], 0, 0⟩
#guard step? [] ⟨.skip, [], [], 0, 0⟩ == none

-- The size measure bounds the number of steps, which is what `finalEnv` uses
-- as fuel: exec → req → skip → take a branch → assign → skip is 4 steps.
#guard size (Cmd.exec [.lit (strS "curl")]) == 2
#guard size Cmd.skip == 0

-- A whole run: an unfilled request opens, status 0, so the then-branch is taken.
#guard lookupVar
         (finalEnv []
           (.ifte (.exec [.lit (strS "curl")])
                  (.assign "x" (.lit (strS "a")))
                  (.assign "x" (.lit (strS "b"))))) "x"
       == strS "a"

-- The same program with a failing fill takes the else-branch.
#guard lookupVar
         (finalEnv [([strS "curl"], ([], 1))]
           (.ifte (.exec [.lit (strS "curl")])
                  (.assign "x" (.lit (strS "a")))
                  (.assign "x" (.lit (strS "b"))))) "x"
       == strS "b"

-- Substitution replaces one input variable and leaves bytes and other
-- variables alone.
#guard substSStr 1 (strS "V") [Atom.byte 97, Atom.inp 1, Atom.inp 2]
       == [Atom.byte 97, Atom.byte 86, Atom.inp 2]

#guard determinate (strS "abc") == true
#guard determinate [Atom.inp 0] == false

#guard elidedVars [Interaction.elided [strS "u"] 3,
                   Interaction.elided [strS "v"] 4] [strS "u"] == [3]
