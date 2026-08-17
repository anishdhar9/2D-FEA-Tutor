# Track D — Integration

Sequential, not parallel. Do this yourself, or as one Claude Code session with the full
repo in context — this is the point where Track A's and Track B's independent
assumptions about the contract get tested against each other, and any mismatch needs a
judgment call rather than another isolated agent guessing which side is right.

## Steps

1. **Wire the real solver in.** Replace every call site in `src/ui/*.js` that currently
   reads a mock Results JSON with a call to Track A's solver, fed by `getModel()` from
   B6. If Track B built strictly against the contract shape, this should be a small,
   mechanical change — if it isn't, that's a sign one track drifted from
   `01-CONTRACTS.md` and the drift needs to be found before proceeding, not
   papered over with a shim.

2. **Run Track C's fixtures end-to-end.** Load `truss-triangle.model.json` through the
   full stack (UI → real solver → UI render) and confirm the numbers match
   `truss-triangle.expected.json` — not just in `node --test`, but visually: the
   rendered deformed shape and color-coded member forces should look identical to
   whatever Track B rendered from the mock data during isolated development. If the
   solver's Phase 1 unit tests pass but the end-to-end render looks wrong, the bug is in
   how the UI is calling or interpreting the solver output, not in the solver.

3. **Repeat for the propped cantilever.** Confirm the UI shows visible sag concentrated
   correctly along the span, a moment-reaction indicator at the fixed end (A) and none at
   the roller (B), and that the sign-convention note in `04-TRACK-C-VALIDATION.md`
   actually rendered correctly (this is the one place a silent sign bug would show up as
   a plausible-looking but backwards diagram).

4. **Edge cases, deliberately, before calling Phase 1/2 done:**
   - An unstable model (e.g. a single unsupported node, or a mechanism with fewer
     constraints than needed) should produce a clear, specific error — "structure is a
     mechanism / singular stiffness matrix" — not a silent NaN or a stack trace surfaced
     raw to the UI.
   - A model with 10-15 elements should solve and render without a noticeable UI hang —
     if it does hang, the bottleneck is almost certainly the hand-rolled Gaussian
     elimination from A4; that's fine at this scale, don't prematurely optimize, but
     confirm it before declaring Phase 2 done rather than discovering it later.

5. **Confirm `diagnostics` is actually populated**, not just present as an empty object.
   Nothing in the Phase 1/2 UI consumes it yet, but Phase 3's work-shown panel depends on
   it existing correctly from day one (per the note in `01-CONTRACTS.md`) — check now,
   while Track A's context is still fresh, rather than after everyone's moved on.

## Definition of done for Phase 1 + 2
- `node --test` passes both fixtures with the stated tolerances.
- Both fixtures render correctly in the UI, checked by eye against the closed-form
  values in `04-TRACK-C-VALIDATION.md`.
- A hand-built model (not one of the two fixtures) with at least one truss and one beam
  element together solves without error — this is the actual test of the "3 DOF/node
  from Phase 1 onward" architecture decision, since neither fixture mixes element types.
