// Element force/stress recovery for both truss and beam (A5, A9).

import { trussGeometry, trussAxialForce } from './truss.js';
import {
  beamGeometry,
  beamLocalStiffness,
  beamRotationMatrix,
  beamEquivalentNodalLoadsLocal,
} from './beam.js';
import { matVecMultiply } from './mat.js';

/**
 * Recover per-element force/stress results from the solved global
 * displacement vector U.
 *
 * Truss (A5): axial force N = (EA/L)*elongation, stress = N/A. Tension
 * positive.
 *
 * Beam (A9): f_local = k_local * T * u_element_global gives the raw
 * stiffness-method nodal force vector. The equivalent nodal loads (A7) were
 * an analysis device standing in for the distributed load, not a physical
 * end force, so they're subtracted back out before reporting. The result is
 * then re-expressed in the conventional shear/moment-diagram sign
 * convention (which differs from the raw direct-stiffness nodal-force
 * convention at end J for shear and at end I for moment — see the
 * shearJ-vs-R_B.ry note in docs/02-TRACK-A-SOLVER.md and the propped-
 * cantilever fixture) rather than the raw nodal-force convention:
 *   axialForceI = -N_I_raw   (tension positive, matches truss convention)
 *   shearI      =  V_I_raw
 *   momentI     = -M_I_raw
 *   axialForceJ =  N_J_raw
 *   shearJ      = -V_J_raw
 *   momentJ     =  M_J_raw
 *
 * @param {*} model normalized Model object
 * @param {*} dof result of buildDofMap(model)
 * @param {number[]} U full global displacement vector
 * @returns {Array} elementForces entries per docs/01-CONTRACTS.md
 */
export function recoverElementForces(model, dof, U) {
  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));
  const distributedByElement = new Map(
    model.loads.distributed.map((d) => [d.element, d.wy])
  );

  const results = [];

  for (const el of model.elements) {
    const nodeI = nodesById.get(el.nodeI);
    const nodeJ = nodesById.get(el.nodeJ);

    if (el.type === 'truss') {
      const { L, l, m } = trussGeometry(nodeI, nodeJ);
      const uI = {
        ux: U[dof.globalIndex(el.nodeI, 'ux')],
        uy: U[dof.globalIndex(el.nodeI, 'uy')],
      };
      const uJ = {
        ux: U[dof.globalIndex(el.nodeJ, 'ux')],
        uy: U[dof.globalIndex(el.nodeJ, 'uy')],
      };
      const axialForce = trussAxialForce(el.E, el.A, L, l, m, uI, uJ);
      results.push({
        element: el.id,
        type: 'truss',
        axialForce,
        axialStress: axialForce / el.A,
      });
    } else if (el.type === 'beam') {
      const { L, c, s } = beamGeometry(nodeI, nodeJ);
      const kLocal = beamLocalStiffness(el.E, el.A, el.I, L);
      const T = beamRotationMatrix(c, s);

      const uGlobal = [
        U[dof.globalIndex(el.nodeI, 'ux')],
        U[dof.globalIndex(el.nodeI, 'uy')],
        U[dof.globalIndex(el.nodeI, 'rz')],
        U[dof.globalIndex(el.nodeJ, 'ux')],
        U[dof.globalIndex(el.nodeJ, 'uy')],
        U[dof.globalIndex(el.nodeJ, 'rz')],
      ];
      const uLocal = matVecMultiply(T, uGlobal);
      const fLocalRaw = matVecMultiply(kLocal, uLocal);

      const wy = distributedByElement.get(el.id) ?? 0;
      const eqLocal =
        wy !== 0 ? beamEquivalentNodalLoadsLocal(wy, L, c, s) : [0, 0, 0, 0, 0, 0];

      const fPhysical = fLocalRaw.map((v, i) => v - eqLocal[i]);
      const [N_I, V_I, M_I, N_J, V_J, M_J] = fPhysical;

      results.push({
        element: el.id,
        type: 'beam',
        axialForceI: -N_I,
        shearI: V_I,
        momentI: -M_I,
        axialForceJ: N_J,
        shearJ: -V_J,
        momentJ: M_J,
      });
    } else {
      throw new Error(`recover: unknown element type "${el.type}" on element "${el.id}"`);
    }
  }

  return results;
}
