/**
 * JSBSim's attitude (Euler angles relative to local north-east-down) -> a three.js quaternion for a model whose nose points
 * along -z, right wing along +x and top along +y. Axes: src/world/coords.ts.
 *
 *   R(model -> world) = C * R(body -> NED) * M
 *   R(body -> NED) = Rz(psi) Ry(theta) Rx(phi)            (the aerospace convention)
 *   C: NED -> world   (x = east, y = -down, z = -north)
 *   M: model -> body  (x_b = -z_m, y_b = x_m, z_b = -y_m)
 */
import * as THREE from 'three';

const m = new THREE.Matrix4();

export function attitudeToQuaternion(phi: number, theta: number, psi: number, out: THREE.Quaternion): THREE.Quaternion {
  const cf = Math.cos(phi), sf = Math.sin(phi);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const cp = Math.cos(psi), sp = Math.sin(psi);
  // body -> NED
  const r11 = ct * cp, r12 = sf * st * cp - cf * sp, r13 = cf * st * cp + sf * sp;
  const r21 = ct * sp, r22 = sf * st * sp + cf * cp, r23 = cf * st * sp - sf * cp;
  const r31 = -st, r32 = sf * ct, r33 = cf * ct;
  // C * R: rows (E, -D, -N)
  const a11 = r21, a12 = r22, a13 = r23;
  const a21 = -r31, a22 = -r32, a23 = -r33;
  const a31 = -r11, a32 = -r12, a33 = -r13;
  // (C R) * M: columns of M are body images of model x, y, z: x_m -> y_b, y_m -> -z_b, z_m -> -x_b
  m.set(
    a12, -a13, -a11, 0,
    a22, -a23, -a21, 0,
    a32, -a33, -a31, 0,
    0, 0, 0, 1,
  );
  return out.setFromRotationMatrix(m);
}
