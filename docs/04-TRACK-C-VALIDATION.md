# Track C — Validation Fixtures

Read `01-CONTRACTS.md` first. This track owns `tests/fixtures/*.json`. Pure data entry —
no dependency on Track A or B's code existing. Both benchmarks below were solved
independently (NumPy, direct stiffness method, double-checked against closed-form beam
theory) before being written down here — treat these as ground truth, not
Claude-generated placeholders.

Write each of the four files below verbatim. Then write `tests/solver.test.js` (depends
on Track A existing to actually run, but the file itself can be written now) that loads
each `.model.json`, runs it through the Track A solver, and asserts every field in the
matching `.expected.json` within the stated tolerance.

---

## Fixture 1 — Triangle truss (Phase 1)

Right-triangle-ish pin-jointed truss, apex load with both horizontal and vertical
components so all three members carry non-trivial force (a purely vertical load aligned
with one member makes the other two carry zero force — not a useful regression test,
avoid that shape of fixture).

`tests/fixtures/truss-triangle.model.json`:
```json
{
  "meta": { "units": "SI" },
  "nodes": [
    { "id": "A", "x": 0.0, "y": 0.0 },
    { "id": "B", "x": 4.0, "y": 0.0 },
    { "id": "C", "x": 2.0, "y": 3.0 }
  ],
  "elements": [
    { "id": "e1", "type": "truss", "nodeI": "A", "nodeJ": "B", "E": 2.0e11, "A": 5.0e-4 },
    { "id": "e2", "type": "truss", "nodeI": "B", "nodeJ": "C", "E": 2.0e11, "A": 5.0e-4 },
    { "id": "e3", "type": "truss", "nodeI": "A", "nodeJ": "C", "E": 2.0e11, "A": 5.0e-4 }
  ],
  "supports": [
    { "node": "A", "ux": true, "uy": true, "rz": false },
    { "node": "B", "ux": false, "uy": true, "rz": false }
  ],
  "loads": {
    "nodal": [
      { "node": "C", "fx": 4000.0, "fy": -10000.0, "mz": 0.0 }
    ],
    "distributed": []
  }
}
```

`tests/fixtures/truss-triangle.expected.json`:
```json
{
  "displacements": [
    { "node": "A", "ux": 0.0, "uy": 0.0, "rz": 0.0 },
    { "node": "B", "ux": 2.1333333333e-4, "uy": 0.0, "rz": 0.0 },
    { "node": "C", "ux": 3.4102749957e-4, "uy": -3.3151203656e-4, "rz": 0.0 }
  ],
  "reactions": [
    { "node": "A", "rx": -4000.0, "ry": 2000.0, "mz": 0.0 },
    { "node": "B", "rx": 0.0, "ry": 8000.0, "mz": 0.0 }
  ],
  "elementForces": [
    { "element": "e1", "type": "truss", "axialForce": 5333.333333, "axialStress": 10666666.666667 },
    { "element": "e2", "type": "truss", "axialForce": -9614.803401, "axialStress": -19229606.802475 },
    { "element": "e3", "type": "truss", "axialForce": -2403.700850, "axialStress": -4807401.700619 }
  ],
  "tolerance": { "displacement": 1e-9, "force": 1e-3, "stress": 1e-2 },
  "equilibriumCheck": "sum(reactions.rx) + 4000 == 0; sum(reactions.ry) - 10000 == 0"
}
```

---

## Fixture 2 — Propped cantilever (Phase 2)

Single beam element, one end fixed, one end on a roller, uniformly distributed load.
Statically indeterminate to degree 1 — this is deliberately the simplest indeterminate
case, specifically to test that the stiffness method handles indeterminacy for free
(nothing extra to code — unlike method-of-sections/force-method approaches, which need
a separate compatibility-equation step, the direct stiffness method doesn't care whether
a structure is determinate or not).

`tests/fixtures/propped-cantilever.model.json`:
```json
{
  "meta": { "units": "SI" },
  "nodes": [
    { "id": "A", "x": 0.0, "y": 0.0 },
    { "id": "B", "x": 4.0, "y": 0.0 }
  ],
  "elements": [
    { "id": "e1", "type": "beam", "nodeI": "A", "nodeJ": "B", "E": 2.0e11, "A": 5.0e-4, "I": 8.0e-6 }
  ],
  "supports": [
    { "node": "A", "ux": true, "uy": true, "rz": true },
    { "node": "B", "ux": false, "uy": true, "rz": false }
  ],
  "loads": {
    "nodal": [],
    "distributed": [
      { "element": "e1", "wy": -10000.0 }
    ]
  }
}
```

`tests/fixtures/propped-cantilever.expected.json`:
```json
{
  "displacements": [
    { "node": "A", "ux": 0.0, "uy": 0.0, "rz": 0.0 },
    { "node": "B", "ux": 0.0, "uy": 0.0, "rz": 0.0083333333 }
  ],
  "reactions": [
    { "node": "A", "rx": 0.0, "ry": 25000.0, "mz": 20000.0 },
    { "node": "B", "rx": 0.0, "ry": 15000.0, "mz": 0.0 }
  ],
  "elementForces": [
    {
      "element": "e1", "type": "beam",
      "axialForceI": 0.0, "shearI": 25000.0, "momentI": -20000.0,
      "axialForceJ": 0.0, "shearJ": -15000.0, "momentJ": 0.0
    }
  ],
  "tolerance": { "displacement": 1e-9, "force": 1e-3, "moment": 1e-3 },
  "closedFormCheck": "R_A.ry = 5wL/8 = 25kN; R_B.ry = 3wL/8 = 15kN; M_A = wL^2/8 = 20kN.m (w=10000 N/m, L=4m)",
  "invarianceCheck": "reactions and elementForces must NOT change if E or I are edited in the model file — only displacements/rotations should. This is a correctness property of a statically-indeterminate single-element solve, worth asserting explicitly, not just eyeballing."
}
```

### Sign-convention gotcha (read before implementing A9)
`shearJ` is **not** the same sign as `R_B.ry`, even though both equal 15000 in
magnitude. `R_B.ry` is the support reaction (positive = upward force from support on
structure). `shearJ` is the internal shear force at the J end using the standard
beam-diagram convention (positive = net upward force from the segment to the left,
acting across the cut) — at the J end of a beam that terminates at a support, this comes
out with the *opposite* sign to the reaction there. Verify this against the closed-form
shear diagram (`V(x) = R_A - w*x`, giving `V(0+)=+25000`, `V(L-)=-15000`), not just
against the raw stiffness-method nodal force vector — the raw nodal force vector at a
constrained DOF gives you the reaction directly, but element-internal shear at that same
node needs the sign flip. This is the single most likely place to introduce a subtle,
hard-to-notice bug in A9 (everything will look plausible, magnitudes will be right,
only the sign at one end will be wrong) — the fixture above locks in the correct signs
specifically so this gets caught by the test suite rather than by eyeballing a diagram
later.
