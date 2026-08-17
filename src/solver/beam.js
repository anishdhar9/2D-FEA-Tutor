// Beam element stiffness + equivalent nodal loads (A6, A7).
//
// Local 6x6 (axial + Euler-Bernoulli bending combined), dof order
// [uI, vI, thetaI, uJ, vJ, thetaJ], per docs/02-TRACK-A-SOLVER.md.
// Transformed to global with a 6x6 rotation built from two 3x3 blocks
// [[c,s,0],[-s,c,0],[0,0,1]].

import { matMultiply, matTranspose } from './mat.js';

/**
 * @param {{x:number,y:number}} nodeI
 * @param {{x:number,y:number}} nodeJ
 * @returns {{L:number, c:number, s:number}}
 */
export function beamGeometry(nodeI, nodeJ) {
  const dx = nodeJ.x - nodeI.x;
  const dy = nodeJ.y - nodeI.y;
  const L = Math.hypot(dx, dy);
  return { L, c: dx / L, s: dy / L };
}

/**
 * Local 6x6 stiffness (axial + bending), dof order
 * [uI, vI, thetaI, uJ, vJ, thetaJ], per A6.
 *
 * @returns {number[][]} 6x6
 */
export function beamLocalStiffness(E, A, I, L) {
  const EAL = (E * A) / L;
  const k12 = (12 * E * I) / (L * L * L);
  const k6 = (6 * E * I) / (L * L);
  const k4 = (4 * E * I) / L;
  const k2 = (2 * E * I) / L;
  return [
    [EAL, 0, 0, -EAL, 0, 0],
    [0, k12, k6, 0, -k12, k6],
    [0, k6, k4, 0, -k6, k2],
    [-EAL, 0, 0, EAL, 0, 0],
    [0, -k12, -k6, 0, k12, -k6],
    [0, k6, k2, 0, -k6, k4],
  ];
}

/**
 * 6x6 rotation matrix from global to local axes, built from two 3x3 blocks
 * [[c,s,0],[-s,c,0],[0,0,1]] per A6. {local} = T * {global}.
 *
 * @returns {number[][]} 6x6
 */
export function beamRotationMatrix(c, s) {
  return [
    [c, s, 0, 0, 0, 0],
    [-s, c, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0],
    [0, 0, 0, c, s, 0],
    [0, 0, 0, -s, c, 0],
    [0, 0, 0, 0, 0, 1],
  ];
}

/**
 * k_global = T^T * k_local * T.
 *
 * @returns {number[][]} 6x6
 */
export function beamGlobalStiffness(kLocal, T) {
  return matMultiply(matTranspose(T), matMultiply(kLocal, T));
}

/**
 * Consistent (work-equivalent) nodal load vector for a uniformly
 * distributed load `wy` (N/m, global +Y direction) over a beam element of
 * length L, expressed in the element's LOCAL axes, full 6-dof order
 * [uI, vI, thetaI, uJ, vJ, thetaJ].
 *
 * docs/02-TRACK-A-SOLVER.md (A7) gives the formula directly in terms of a
 * transverse `wy` for the horizontal-beam case:
 *   F_eq = [wy*L/2, wy*L^2/12, wy*L/2, -wy*L^2/12]  on [vI, thetaI, vJ, thetaJ]
 * Since `wy` is defined in GLOBAL Y (not necessarily the element's local
 * transverse axis) this implementation decomposes it into local
 * transverse/axial components via the element's direction cosines before
 * applying that formula, so it reduces to exactly the doc's formula for a
 * horizontal element (c=1, s=0) and generalizes correctly for an inclined
 * beam/frame element.
 *
 * @param {number} wy global-Y UDL, N/m
 * @param {number} L element length
 * @param {number} c cos(theta), element local-x direction cosine
 * @param {number} s sin(theta), element local-x direction cosine
 * @returns {number[]} length-6 local load vector
 */
export function beamEquivalentNodalLoadsLocal(wy, L, c, s) {
  // Project the global (0, wy) load per unit length onto the element's
  // local axes: local-x (axial) component = wy*s, local-y (transverse)
  // component = wy*c — see beamRotationMatrix's {local}=T*{global} convention.
  const wyLocal = wy * c;
  const wxLocal = wy * s;
  return [
    (wxLocal * L) / 2,
    (wyLocal * L) / 2,
    (wyLocal * L * L) / 12,
    (wxLocal * L) / 2,
    (wyLocal * L) / 2,
    -(wyLocal * L * L) / 12,
  ];
}
