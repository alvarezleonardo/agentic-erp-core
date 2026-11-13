import { randomBytes, randomUUID } from 'node:crypto';

export type Obj = Record<string, unknown>;

export const esObjeto = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copia profunda de datos JSON (los registros de pruebas no deben mutar después). */
export function clonar<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

// `pin` como palabra del nombre (pin, supervisor_pin, pin_nuevo): no confundir con otras palabras ("pinza").
const CLAVE_SECRETA = /token|secret|password|api[_-]?key|(?:^|_)pin(?:$|_)/i;

/** Copia sin ningún campo cuyo nombre sugiera un secreto. Se aplica a todo resultado de tool ANTES de que lo vea el modelo. */
export function quitarSecretos<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map((x) => quitarSecretos(x)) as T;
  if (esObjeto(valor)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(valor)) if (!CLAVE_SECRETA.test(k)) out[k] = quitarSecretos(v);
    return out as T;
  }
  return valor;
}

/** Igual que quitarSecretos pero deja una marca (para trazas). También oculta claves de API con forma conocida. */
export function redactar<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map((x) => redactar(x)) as T;
  if (esObjeto(valor)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(valor)) out[k] = CLAVE_SECRETA.test(k) ? '[redactado]' : redactar(v);
    return out as T;
  }
  if (typeof valor === 'string' && /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}/.test(valor)) return '[redactado]' as T;
  return valor;
}

/**
 * Detecta cifras con pinta de importe en texto libre del modelo: símbolo de moneda, miles con separador,
 * decimales con dos dígitos o números de 5 o más dígitos. Los números chicos (3 partes, 12 unidades) pasan.
 */
const PATRON_MONTO = /\$|\b\d+(?:[.,]\d+)?\s*(?:usd|us\$|d[oó]lar(?:es)?|pesos?|euros?|eur)\b|\b(?:usd|eur)\s*\d|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?\b|\b\d+[.,]\d{2}\b|\b\d{5,}\b/i;
export const contieneMonto = (texto: string): boolean => PATRON_MONTO.test(texto);

// ---- ids ----
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 48 bits de tiempo + 80 bits aleatorios (Crockford base32). Ordenable por tiempo. */
export function ulid(ahora: number = Date.now()): string {
  let t = ahora;
  let tiempo = '';
  for (let i = 0; i < 10; i++) {
    tiempo = CROCKFORD[t % 32] + tiempo;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let aleatorio = '';
  for (let i = 0; i < 16; i++) aleatorio += CROCKFORD[(bytes[i] ?? 0) % 32];
  return tiempo + aleatorio;
}

export const nuevoMessageId = (): string => ulid();
export const nuevoIntentId = (): string => `int_${ulid().slice(-12).toLowerCase()}`;
export const nuevoTraceId = (): string => `tr_${randomUUID().slice(0, 8)}`;
export const nuevoSessionId = (): string => `ses_${randomUUID().slice(0, 8)}`;
