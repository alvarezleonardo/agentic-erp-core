import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Referencia para el SERVIDOR (no la usa el orquestador): cómo guardar y verificar el PIN de quien autoriza un
 * step-up. El PIN se guarda con scrypt y sal propia, nunca en claro; la verificación compara en tiempo constante.
 * Un servidor real puede usar otro algoritmo (argon2, bcrypt): lo que importa es no guardarlo reversible.
 */

const LARGO_CLAVE = 32;
const LARGO_SAL = 16;

/** `sal:hash` en hexadecimal. Sin `sal` se genera una aleatoria de 16 bytes. */
export function hashPin(pin: string, sal: string = randomBytes(LARGO_SAL).toString('hex')): string {
  if (!sal || sal.includes(':')) throw new Error('la sal no puede estar vacía ni contener ":"');
  return `${sal}:${scryptSync(pin, sal, LARGO_CLAVE).toString('hex')}`;
}

/** ¿El PIN corresponde al hash guardado (`sal:hash`)? Comparación en tiempo constante; un hash mal formado da `false`. */
export function verificarPin(pin: string, hash: string): boolean {
  const [sal, esperado, ...resto] = hash.split(':');
  if (!sal || !esperado || resto.length || !/^[0-9a-f]+$/i.test(esperado)) return false;
  const a = scryptSync(pin, sal, LARGO_CLAVE);
  const b = Buffer.from(esperado, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
