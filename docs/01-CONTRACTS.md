# Data Contracts (frozen)

Every track reads this file first. Nobody changes it unilaterally — if a track's
implementation reveals a gap, stop and flag it rather than silently extending the schema.

## Units
SI throughout. Length: m. Force: N. Moment: N·m. Stress/modulus: Pa. Area: m². Second
moment of area: m⁴. Rotation: rad. No unit conversion happens in the UI layer — if a
future version wants mm/kN input, that's a display-layer concern, not a schema concern.

## Architecture decision: 3 DOF/node from Phase 1 onward
Every node gets 3 DOF: `ux`, `uy`, `rz` — even in Phase 1, where truss elements only
populate the `ux`/`uy` sub-block of the stiffness matrix. Reason: this avoids renumbering
every node when Phase 2 introduces beam elements at some of them. The cost: a node
touched *only* by truss elements has an all-zero row/column at its `rz` DOF, which is
singular if left in the system to solve.

**Required implementation rule (Track A):** after assembly, before solving, auto-detect
any DOF whose entire row in the global K is zero (within floating-point tolerance) and
exclude it from the solve — treat it as inactive, not as a free unknown. Do not require
the model author to manually pin every truss-only node's `rz`. Report inactive DOFs in
`diagnostics.inactiveDofs` (see Results schema) so the UI can distinguish "solver
excluded this" from "user forgot a support."

## Model schema (input)

```json
{
  "meta": { "units": "SI" },
  "nodes": [
    { "id": "A", "x": 0.0, "y": 0.0 }
  ],
  "elements": [
    {
      "id": "e1",
      "type": "truss",
      "nodeI": "A",
      "nodeJ": "B",
      "E": 200e9,
      "A": 500e-6
    },
    {
      "id": "e2",
      "type": "beam",
      "nodeI": "A",
      "nodeJ": "B",
      "E": 200e9,
      "A": 500e-6,
      "I": 8e-6
    }
  ],
  "supports": [
    { "node": "A", "ux": true, "uy": true, "rz": false },
    { "node": "B", "ux": false, "uy": true, "rz": false }
  ],
  "loads": {
    "nodal": [
      { "node": "C", "fx": 4000.0, "fy": -10000.0, "mz": 0.0 }
    ],
    "distributed": [
      { "element": "e2", "wy": -10000.0 }
    ]
  }
}
```

Field notes:
- `elements[].type`: `"truss"` (Phase 1) or `"beam"` (Phase 2). Solver dispatches on this.
- Truss elements ignore `I` if present; validator should warn (not error) if `I` is
  supplied on a truss element.
- `supports[].rz`: only meaningful for nodes touched by a beam element. On a truss-only
  node, `rz: true` is a no-op (that DOF is already excluded per the rule above) — don't
  error on it, just ignore it.
- `loads.distributed[].wy`: uniformly distributed load, N/m, in global Y direction,
  applied over the full length of the referenced element. Only valid on `"beam"`
  elements. Phase 1 fixtures will have an empty `distributed` array.
- Every `node`/`element` id is a string, unique within its collection. Solver and UI both
  index by id, not array position — do not rely on array order anywhere.

## Results schema (output)

```json
{
  "displacements": [
    { "node": "A", "ux": 0.0, "uy": 0.0, "rz": 0.0 }
  ],
  "reactions": [
    { "node": "A", "rx": -4000.0, "ry": 2000.0, "mz": 0.0 }
  ],
  "elementForces": [
    {
      "element": "e1",
      "type": "truss",
      "axialForce": 5333.333333,
      "axialStress": 10666666.666667
    },
    {
      "element": "e2",
      "type": "beam",
      "axialForceI": 0.0,
      "shearI": 25000.0,
      "momentI": -20000.0,
      "shearJ": -15000.0,
      "momentJ": 0.0
    }
  ],
  "diagnostics": {
    "inactiveDofs": ["A.rz", "B.rz"],
    "dofNumbering": { "A": { "ux": 0, "uy": 1, "rz": 2 } },
    "elementLocalK": { "e1": [[/* 4x4 or 6x6 */]] },
    "elementGlobalK": { "e1": [[/* same shape, post-transform */]] },
    "globalK": [[ /* full assembled matrix, pre-partition */ ]],
    "partition": { "free": ["C.ux", "C.uy"], "fixed": ["A.ux", "A.uy", "B.uy"] }
  }
}
```

Field notes:
- `reactions`: only present for nodes with at least one fixed DOF. A node with no support
  does not appear in this array.
- `elementForces`: sign convention — tension positive for truss axial force. For beam
  elements, `momentI`/`momentJ` use the direct-stiffness convention (positive = 
  counterclockwise, z out of page); this matches the local stiffness matrix in
  `02-TRACK-A-SOLVER.md`, don't reinvent a different convention for display.
- `diagnostics`: **required field, populate it in Phase 1**, even though the "show your
  work" UI panel that consumes it is Phase 3. Track A must return this data from day one
  — retrofitting it later means changing the solver's internal structure after Track B
  has already built against a Results shape that didn't have it. Track B can ignore
  `diagnostics` entirely in Phase 1/2 UI work; it only needs to exist in the object.

## Element type registry
| type | DOF/node used | Phase | Owns |
|------|---------------|-------|------|
| `truss` | ux, uy | 1 | `src/solver/truss.js` |
| `beam` | ux, uy, rz | 2 | `src/solver/beam.js` |
