import { quitarSecretos, esObjeto, type Obj } from './util.js';

/** Un comando directo: una tool y sus argumentos, sin pasar por el modelo (`user.input.comando`, protocolo 1.1). */
export interface Comando {
  tool: string;
  args: Obj;
}

/** Extrae `comando` de un `user.input` ya validado contra client-message.schema.json. */
export function comandoDeMensaje(m: Obj): Comando | undefined {
  const c = m['comando'];
  if (!esObjeto(c) || typeof c['tool'] !== 'string') return undefined;
  return { tool: c['tool'], args: esObjeto(c['args']) ? { ...c['args'] } : {} };
}

/** Componentes por defecto del modo directo. */
export type ComponentePorDefecto = 'DataTable' | 'DetailCard';

export interface VistaPorDefecto {
  componente: ComponentePorDefecto;
  /** Salida con la forma que el hidratador del componente acepta. Sale por completo de lo que devolvió el servidor. */
  salida: Obj;
}

const MAX_COLUMNAS = 20;
const MAX_CAMPOS = 40;

const etiquetaDe = (clave: string): string => {
  const t = clave.replace(/_+/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : clave;
};

const esDinero = (v: unknown): boolean => esObjeto(v) && typeof v['monto'] === 'string' && typeof v['moneda'] === 'string';

function comoTexto(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (esDinero(v)) return `${(v as Obj)['monto'] as string} ${(v as Obj)['moneda'] as string}`;
  if (Array.isArray(v)) return `${v.length} elemento${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 200);
  return String(v);
}

/**
 * Elige el componente de un resultado de lectura cuando el integrador no registró uno para la tool:
 * una lista (tabla, o la primera propiedad que sea una lista de objetos) va a `DataTable` y un objeto va a `DetailCard`.
 * Si el resultado ya viene con la forma de tabla o de detalle del contrato se usa tal cual; si no, se arma una vista
 * genérica con lo que devolvió el servidor, sin sacar ni inventar datos.
 */
export function vistaPorDefecto(tool: string, salida: Obj): VistaPorDefecto {
  const limpia = quitarSecretos(salida);
  if (Array.isArray(limpia['columnas']) && Array.isArray(limpia['filas'])) return { componente: 'DataTable', salida: limpia };
  if (typeof limpia['titulo'] === 'string' && Array.isArray(limpia['campos']) && limpia['campos'].length > 0) return { componente: 'DetailCard', salida: limpia };

  const titulo = typeof limpia['titulo'] === 'string' && limpia['titulo'] ? limpia['titulo'].slice(0, 120) : etiquetaDe(tool);
  const lista = Object.entries(limpia).find((e): e is [string, Obj[]] => Array.isArray(e[1]) && e[1].length > 0 && e[1].every(esObjeto));
  if (lista) {
    const [clave, filas] = lista;
    const claves = [...new Set(filas.slice(0, 50).flatMap((f) => Object.keys(f)))].slice(0, MAX_COLUMNAS);
    const columnas = claves.map((k) => ({ id: k, etiqueta: etiquetaDe(k), ...(filas.every((f) => f[k] === undefined || esDinero(f[k])) && filas.some((f) => esDinero(f[k])) ? { tipo: 'dinero' as const } : {}) }));
    return { componente: 'DataTable', salida: { titulo: titulo === etiquetaDe(tool) ? etiquetaDe(clave).slice(0, 120) : titulo, columnas, filas, total_filas: filas.length } };
  }
  const campos = Object.entries(limpia)
    .filter(([k]) => k !== 'titulo')
    .slice(0, MAX_CAMPOS)
    .map(([k, v]) => ({ etiqueta: etiquetaDe(k), valor: comoTexto(v) }));
  return { componente: 'DetailCard', salida: { titulo, campos: campos.length ? campos : [{ etiqueta: 'Resultado', valor: 'Sin datos' }] } };
}
