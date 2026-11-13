import type { Dinero } from './tipos.js';

/** Aritmética de dinero en centavos enteros: ningún float toca un importe. */

export const MONEDA_POR_DEFECTO = 'USD';

export function dineroDeCentavos(centavos: number, moneda: string = MONEDA_POR_DEFECTO): Dinero {
  if (!Number.isInteger(centavos)) throw new Error('los centavos deben ser un entero');
  const signo = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  return { monto: `${signo}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`, moneda };
}

export function centavosDeDinero(d: Dinero): number {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(d.monto);
  if (!m) throw new Error(`monto inválido: ${d.monto}`);
  const valor = Number(m[2]) * 100 + Number(m[3]);
  return m[1] === '-' ? -valor : valor;
}

/** Cantidad decimal (hasta 3 decimales) por precio en centavos, redondeado al centavo. */
export function multiplicar(precioCentavos: number, cantidad: string): number {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cantidad);
  if (!m) throw new Error(`cantidad inválida: ${cantidad}`);
  const milesimas = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
  return Math.round((precioCentavos * milesimas) / 1000);
}

export const sumarCentavos = (valores: readonly number[]): number => valores.reduce((a, b) => a + b, 0);
