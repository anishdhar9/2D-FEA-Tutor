// Truss element stiffness (A3).
//
// Local-to-global element stiffness, direction cosines l = (xJ-xI)/L,
// m = (yJ-yI)/L, per docs/02-TRACK-A-SOLVER.md. Populates only the ux/uy
// sub-block of each of the element's two nodes — rz is left untouched by
// this element type.

/**
 * @param {{x:number,y:number}} nodeI
 * @param {{x:number,y:number}} nodeJ
 * @returns {{L:number, l:number, m:number}}
 */
export function trussGeometry(nodeI, nodeJ) {
  const dx = nodeJ.x - nodeI.x;
  const dy = nodeJ.y - nodeI.y;
  const L = Math.hypot(dx, dy);
  return { L, l: dx / L, m: dy / L };
}

/**
 * Element stiffness in the element's own local axes (dof order
 * [uI, vI, uJ, vJ]) — only the axial (local-x) direction carries stiffness
 * for a pin-jointed truss member.
 *
 * @returns {number[][]} 4x4
 */
export function trussLocalStiffness(E, A, L) {
  const k = (E * A) / L;
  return [
    [k, 0, -k, 0],
    [0, 0, 0, 0],
    [-k, 0, k, 0],
    [0, 0, 0, 0],
  ];
}

/**
 * Element stiffness rotated into global axes, dof order [uI, vI, uJ, vJ].
 * This is algebraically T^T * trussLocalStiffness * T for the truss
 * rotation T, given directly per the closed form in
 * docs/02-TRACK-A-SOLVER.md (A3).
 *
 * @returns {number[][]} 4x4
 */
export function trussGlobalStiffness(E, A, L, l, m) {
  const k = (E * A) / L;
  return [
    [k * l * l, k * l * m, -k * l * l, -k * l * m],
    [k * l * m, k * m * m, -k * l * m, -k * m * m],
    [-k * l * l, -k * l * m, k * l * l, k * l * m],
    [-k * l * m, -k * m * m, k * l * m, k * m * m],
  ];
}

/**
 * Recover axial force from global nodal displacements. Tension positive.
 *
 * @param {number} E
 * @param {number} A
 * @param {number} L
 * @param {number} l direction cosine (xJ-xI)/L
 * @param {number} m direction cosine (yJ-yI)/L
 * @param {{ux:number, uy:number}} uI global displacement at node I
 * @param {{ux:number, uy:number}} uJ global displacement at node J
 * @returns {number} axial force, tension positive
 */
export function trussAxialForce(E, A, L, l, m, uI, uJ) {
  const elongation = l * (uJ.ux - uI.ux) + m * (uJ.uy - uI.uy);
  return ((E * A) / L) * elongation;
}
