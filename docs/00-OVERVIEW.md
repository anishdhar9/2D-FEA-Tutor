# 2D FEA Teaching Tool — Phase 1 & 2 Execution Plan

## Goal
Client-side (no backend) web app: 2D truss solver (Phase 1) extended to 2D frame/beam
elements (Phase 2), direct stiffness method, with every intermediate matrix inspectable
("show your work" — this is the differentiator vs. SkyCiv/Truzme/STRIAN, all of which
hide the math or cap at truss-only).

## Repo layout
```
/src
  model.js            # Model schema helpers, validation (Track A owns)
  dofmap.js            # Global DOF numbering (Track A owns)
  solver/
    truss.js            # Phase 1: truss element stiffness + assembly
    beam.js              # Phase 2: beam element stiffness + equivalent nodal loads
    assemble.js         # Generic assembly + partition + solve
    recover.js           # Element force/stress recovery
  ui/
    canvas.js            # Node/element placement, click-to-select (Track B owns)
    render.js            # Deformed shape, force/stress color mapping (Track B owns)
    results-panel.js     # Displacement/reaction/force tables (Track B owns)
/tests
  fixtures/
    truss-triangle.model.json
    truss-triangle.expected.json
    propped-cantilever.model.json
    propped-cantilever.expected.json
  solver.test.js         # Track A tests against fixtures (Track C provides fixtures)
  ui.test.js              # Track B tests against mock model/results (Track C provides mocks)
/docs
  01-CONTRACTS.md         # <- read this before writing any code
  02-TRACK-A-SOLVER.md
  03-TRACK-B-UI.md
  04-TRACK-C-VALIDATION.md
  05-TRACK-D-INTEGRATION.md
index.html
```

## Why this splits cleanly into parallel work
The solver (Track A) is a pure function: `Model JSON -> Results JSON`. It has zero DOM
dependency and can be built and unit-tested in complete isolation. The UI (Track B) only
needs the *shape* of Model/Results JSON, not a working solver — it can be built and
visually verified against static mock JSON files. Validation (Track C) is just hand-verified
benchmark problems as JSON fixtures — pure data entry, no dependency on either A or B's
code existing yet. This is why `01-CONTRACTS.md` is the one file that must be frozen
*before* any track starts, and the one file no track should silently change.

## Dependency graph
```
01-CONTRACTS.md (frozen first, ~30 min, do this yourself or as a single Claude Code pass)
        |
        +---------------------+---------------------+
        |                     |                     |
   TRACK A (solver)      TRACK B (UI)          TRACK C (validation)
   src/model.js,          src/ui/*.js,          tests/fixtures/*.json
   src/dofmap.js,         works against          (hand-verified numbers,
   src/solver/*.js        mock Model/Results      see 04-TRACK-C-VALIDATION.md)
        |                     |                     |
        +---------------------+---------------------+
                              |
                    TRACK D (integration)
                    wire real solver into real UI,
                    run Track C fixtures through Track A,
                    sequential, ~2-4 hrs, do this yourself
```

A, B, and C have no file-level or import-level overlap — three Claude Code sessions can
run concurrently, each pointed at its own doc under `/docs`, each told to read
`01-CONTRACTS.md` first and treat it as read-only. Track D is intentionally sequential
and short — it's just wiring, and it's the point where you actually want a human (or one
Claude Code session with full context) reviewing the integration rather than three parallel
agents touching the same files.

## Suggested execution
1. You (or one Claude Code pass): finalize `01-CONTRACTS.md`. ~30 min, low risk of rework
   later if you get this right — everything else depends on it staying stable.
2. Three parallel Claude Code sessions, one per track, each prompted with:
   "Read /docs/01-CONTRACTS.md and /docs/0X-TRACK-X.md. Implement only the tasks listed
   there. Do not modify files outside your track's ownership list. Do not modify
   01-CONTRACTS.md — if you believe it's wrong, stop and report why instead of changing it."
3. Merge. Run `node --test` (Track A's tests) and open `index.html` (Track B's UI against
   mocks) to confirm both work independently before integration.
4. Track D, sequential: swap Track B's mock data calls for real Track A solver calls,
   run Track C's fixtures end-to-end, confirm numbers match within tolerance.

## Phase boundary
Phase 1 = truss only (element type `"truss"`, 2 active DOF/node). Phase 2 = adds beam
elements (element type `"beam"`, 3 DOF/node, bending). Both phases share one contract —
Phase 2 is additive to the schema, not a breaking change (see 01-CONTRACTS.md for why 3
DOF/node is allocated from Phase 1 onward even though truss elements don't use `rz`).
