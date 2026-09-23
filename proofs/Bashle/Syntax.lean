/-!
# Syntax for bashle's holes semantics, v0

Mirrors the grammar in `docs/semantics.md`.  Milestone 1 is the bare core: no
loops, no command substitution, no functions, no store.
-/

namespace Bashle

/-- An input variable `ι`.  One is minted per *request* that has no fill —
    per request, not per invocation, because one fill answers every call. -/
abbrev InputVar := Nat

/-- Determinate bytes.  A fill's payload is always determinate — that is what a
    fill is — so this type deliberately cannot mention an `InputVar`. -/
abbrev Bytes := List UInt8

/-- `ŝ ::= ε | b·ŝ | ι·ŝ` is the free monoid over bytes and input variables, so
    one atom is one generator. -/
inductive Atom where
  | byte : UInt8 → Atom
  | inp  : InputVar → Atom
  deriving DecidableEq, Repr

/-- A symbolic string.  Concatenation is `++`: `ŝ₁ŝ₂` is what the shell does
    anyway, which is why the implementation's sentinel needs no cooperation
    from bash. -/
abbrev SStr := List Atom

/-- Inject determinate bytes into the symbolic strings.

    Not written as `Bytes.toSStr`: `Bytes` is an abbreviation for `List UInt8`,
    so `b.toSStr` would resolve against the `List` namespace and fail. -/
def toSStr (b : Bytes) : SStr := b.map Atom.byte

/-- The readable spelling of a literal, for tests and examples. -/
def strS (s : String) : SStr := toSStr s.toUTF8.toList

abbrev Var := String

/-- `w ::= lit b | var x | w · w | quoted w`

    `quoted` is the identity in v0, because v0 does not define word splitting.
    It is carried anyway: it is precisely the constructor that will *stop*
    splitting once O1 is addressed, and an unquoted symbolic value splitting
    into an unknown number of words is the whole of O1. -/
inductive Word where
  | lit    : SStr → Word
  | var    : Var → Word
  | cat    : Word → Word → Word
  | quoted : Word → Word
  deriving DecidableEq, Repr

/-- A normalized request: the expanded argv.  `r` in the rules. -/
abbrev Request := List SStr

/-- `Interaction ::= answered(r, b, n) | elided(r, ι)`

    `elided` is the "external output that never happened" case: the effect was
    skipped, and that fact is part of the run's meaning. -/
inductive Interaction where
  | answered : Request → Bytes → Nat → Interaction
  | elided   : Request → InputVar → Interaction
  deriving DecidableEq, Repr

abbrev Trace := List Interaction

/-- `c ::= x := w | exec w⃗ | c ; c | if c then c else c`

    Two constructors are not surface syntax.  `skip` is the terminal
    configuration, needed because the semantics is small-step.  `req` is what
    `exec` reduces to — see `Step.exec`. -/
inductive Cmd where
  | skip   : Cmd
  | assign : Var → Word → Cmd
  | exec   : List Word → Cmd
  | seq    : Cmd → Cmd → Cmd
  | ifte   : Cmd → Cmd → Cmd → Cmd
  | req    : Request → Cmd
  deriving DecidableEq, Repr

instance : Inhabited Cmd := ⟨.skip⟩

end Bashle
