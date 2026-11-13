import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ContextoSesion, Obj } from './tipos.js';
import { esObjeto } from './tipos.js';

/**
 * Kit de servidor conforme: las piezas que todo `preparar_*` / `confirmar_*` necesita y que conviene no reescribir
 * (serialización estable, hash de payload, token de confirmación, idempotencia). Es una referencia: un servidor puede
 * implementarlas distinto mientras cumpla CONTRACT.md.
 */

/** JSON canónico: claves ordenadas en todos los niveles y sin claves `undefined`. Mismo valor, mismo texto. */
export function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map((v) => (v === undefined ? 'null' : canonico(v))).join(',')}]`;
  if (esObjeto(valor)) {
    return `{${Object.keys(valor)
      .filter((k) => valor[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

const sha256 = (texto: string): string => createHash('sha256').update(texto).digest('hex');

/** SHA-256 (hex) del JSON canónico: sirve para detectar que una propuesta guardada no fue alterada. */
export const hashPayload = (valor: unknown): string => sha256(canonico(valor));

/** Token de confirmación: 24 bytes aleatorios en hexadecimal con prefijo `cft_`. Es secreto y de un solo uso. */
export const emitirToken = (): string => `cft_${randomBytes(24).toString('hex')}`;

/** Compara dos tokens en tiempo constante (también cuando tienen distinto largo). */
export function tokenCoincide(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Clave de idempotencia derivada, para confirmar una propuesta cuando la superficie no manda la suya:
 * misma persona, mismo tenant y misma propuesta dan siempre la misma clave, así un doble toque nunca ejecuta dos veces.
 */
export function claveIdempotencia(contexto: Pick<ContextoSesion, 'tenant' | 'usuario'>, proposalId: string): string {
  return `idk_${hashPayload({ tenant: contexto.tenant, usuario: contexto.usuario, proposal_id: proposalId }).slice(0, 32)}`;
}

const CLAVE_SECRETA = /token|secret|password|(?:^|_)pin(?:$|_)|^idempotency_key$|^contexto$/i;

/**
 * Hash de la entrada de una operación idempotente, SIN los secretos (token, PIN) ni la clave misma ni el contexto:
 * un PIN de pocos dígitos se recuperaría por fuerza bruta desde un hash guardado.
 */
export function hashEntrada(entrada: Obj): string {
  const limpiar = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(limpiar);
    if (esObjeto(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => !CLAVE_SECRETA.test(k)).map(([k, x]) => [k, limpiar(x)]));
    return v;
  };
  return hashPayload(limpiar(entrada));
}

// ---------- Idempotencia ----------

export interface EntradaIdempotencia {
  /** `hashEntrada` de lo que se ejecutó: la misma clave con otra entrada es un conflicto. */
  hashEntrada: string;
  /** Lo que devolvió la operación la primera vez. */
  resultado: Obj;
}

/**
 * Puerto de la tabla de idempotencia. Un servidor real lo implementa sobre su base de datos (clave única por
 * tenant); `RegistroIdempotenciaMemoria` es la versión para pruebas y ejemplos.
 */
export interface RegistroIdempotencia {
  obtener(contexto: Pick<ContextoSesion, 'tenant'>, clave: string): Promise<EntradaIdempotencia | undefined>;
  guardar(contexto: Pick<ContextoSesion, 'tenant'>, clave: string, entrada: EntradaIdempotencia): Promise<void>;
}

/** Registro en memoria, aislado por tenant. No persiste ni se comparte entre procesos. */
export class RegistroIdempotenciaMemoria implements RegistroIdempotencia {
  private readonly datos = new Map<string, EntradaIdempotencia>();

  async obtener(contexto: Pick<ContextoSesion, 'tenant'>, clave: string): Promise<EntradaIdempotencia | undefined> {
    const e = this.datos.get(this.llave(contexto, clave));
    return e ? { hashEntrada: e.hashEntrada, resultado: structuredClone(e.resultado) } : undefined;
  }

  async guardar(contexto: Pick<ContextoSesion, 'tenant'>, clave: string, entrada: EntradaIdempotencia): Promise<void> {
    this.datos.set(this.llave(contexto, clave), { hashEntrada: entrada.hashEntrada, resultado: structuredClone(entrada.resultado) });
  }

  private llave(contexto: Pick<ContextoSesion, 'tenant'>, clave: string): string {
    return `${contexto.tenant}\u0000${clave}`;
  }
}

export type ConsultaIdempotencia =
  /** Primera vez con esta clave: hay que ejecutar y después `guardar`. */
  | { estado: 'nueva' }
  /** Repetición exacta: devolver `resultado` marcado como idempotente, sin repetir el efecto. */
  | { estado: 'repetida'; resultado: Obj }
  /** Misma clave con otra entrada: rechazar (`PARAMETRO_INVALIDO`). */
  | { estado: 'conflicto' };

/** Qué hacer con una operación según lo que ya hay registrado para su clave. */
export async function consultarIdempotencia(registro: RegistroIdempotencia, contexto: Pick<ContextoSesion, 'tenant'>, clave: string, entrada: Obj): Promise<ConsultaIdempotencia> {
  const previo = await registro.obtener(contexto, clave);
  if (!previo) return { estado: 'nueva' };
  return previo.hashEntrada === hashEntrada(entrada) ? { estado: 'repetida', resultado: previo.resultado } : { estado: 'conflicto' };
}

/** Registra el resultado de una operación recién ejecutada, atada al hash de su entrada. */
export const registrarIdempotencia = (registro: RegistroIdempotencia, contexto: Pick<ContextoSesion, 'tenant'>, clave: string, entrada: Obj, resultado: Obj): Promise<void> =>
  registro.guardar(contexto, clave, { hashEntrada: hashEntrada(entrada), resultado });
