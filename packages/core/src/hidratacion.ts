import { stepUpDe, type StepUp } from '@agentic-erp/mcp-contract';
import type { Fuente } from './ProposalStore.js';
import { esObjeto, type Obj } from './util.js';

export interface AccionCatalogo {
  id: string;
  label: string;
  kind: 'primary' | 'secondary' | 'ghost' | 'danger';
  confirms?: boolean;
  /**
   * Qué pide la superficie al confirmar, dentro del componente: `motivo` (texto obligatorio), `supervisor` (usuario y PIN de
   * otra persona) o `supervisor_y_motivo`. `autorizacion` es el nombre anterior de `supervisor`.
   */
  step_up?: StepUp | 'autorizacion';
}

export interface ContextoHidratacion {
  ahora: () => Date;
}

export interface Hidratado {
  /** Lo que el servidor puso en `data` (pisa cualquier cosa que escriba el modelo). */
  fuente: Obj;
  acciones?: AccionCatalogo[];
  error?: string;
}

/**
 * Un hidratador arma la `data` de un componente a partir de la salida literal de un tool. Es lo que garantiza que
 * los montos y los datos los ponga el servidor: el modelo solo elige el componente y la fuente.
 */
export interface Hidratador {
  /** Qué fuente espera, para el mensaje de error que ve el modelo. */
  esperada: string;
  acepta(f: Fuente): boolean;
  hidratar(f: Fuente, ctx: ContextoHidratacion): Hidratado;
}

const copiar = (salida: Obj, campos: readonly string[]): Obj => {
  const out: Obj = {};
  for (const c of campos) if (salida[c] !== undefined) out[c] = salida[c];
  return out;
};

export const MAX_FILAS_TABLA = 200;

const ConfirmationCard: Hidratador = {
  esperada: 'un preparar_* (una propuesta)',
  acepta: (f) => f.kind === 'proposal',
  hidratar(f, ctx) {
    const s = f.salida;
    const expira = typeof s['expira_en'] === 'string' ? Date.parse(s['expira_en']) : NaN;
    if (Number.isFinite(expira) && expira <= ctx.ahora().getTime()) return { fuente: {}, error: `La propuesta ${f.id} venció; volvé a preparar la operación` };
    const stepUp = stepUpDe(s);
    return {
      fuente: { ...copiar(s, ['proposal_id', 'titulo', 'resumen', 'lineas', 'total', 'advertencias', 'requiere_step_up', 'expira_en', 'confirmation_token']), ...(stepUp !== 'none' ? { step_up: stepUp } : {}) },
      acciones: [
        { id: 'confirmar', label: 'Confirmar', kind: 'primary', confirms: true, ...(stepUp !== 'none' ? { step_up: stepUp } : {}) },
        { id: 'cancelar', label: 'Cancelar', kind: 'ghost' },
      ],
    };
  },
};

const DataTable: Hidratador = {
  esperada: 'una lectura tabular (columnas y filas)',
  acepta: (f) => f.kind === 'tool' && Array.isArray(f.salida['columnas']) && Array.isArray(f.salida['filas']),
  hidratar(f) {
    const filas = f.salida['filas'] as unknown[];
    const out = copiar(f.salida, ['titulo', 'columnas', 'total_filas']);
    out['filas'] = filas.slice(0, MAX_FILAS_TABLA);
    if (filas.length > MAX_FILAS_TABLA) out['truncada'] = true;
    return { fuente: out };
  },
};

const KpiTiles: Hidratador = {
  esperada: 'una lectura de métricas (kpis)',
  acepta: (f) => f.kind === 'tool' && Array.isArray(f.salida['kpis']),
  hidratar: (f) => ({ fuente: copiar(f.salida, ['periodo', 'kpis', 'fuente']) }),
};

const DetailCard: Hidratador = {
  esperada: 'una lectura de detalle (titulo y campos)',
  acepta: (f) => f.kind === 'tool' && typeof f.salida['titulo'] === 'string' && Array.isArray(f.salida['campos']),
  hidratar: (f) => ({ fuente: copiar(f.salida, ['titulo', 'campos']) }),
};

const TrendChart: Hidratador = {
  esperada: 'una lectura de serie (x y series)',
  acepta: (f) => f.kind === 'tool' && Array.isArray(f.salida['x']) && Array.isArray(f.salida['series']),
  hidratar: (f) => ({ fuente: copiar(f.salida, ['unidad', 'x', 'series']) }),
};

/** Hidratadores de los componentes genéricos. Un despliegue puede sumar los suyos: `{ ...HIDRATADORES_BASE, MiTarjeta }`. */
export const HIDRATADORES_BASE: Readonly<Record<string, Hidratador>> = { ConfirmationCard, DataTable, KpiTiles, DetailCard, TrendChart };

/** Busca el objeto de un resultado de tool que tiene un id (`id`, `*_id`) igual a `id`. */
export function buscarPorId(valor: unknown, id: string): Obj | undefined {
  if (Array.isArray(valor)) {
    for (const x of valor) {
      const r = buscarPorId(x, id);
      if (r) return r;
    }
    return undefined;
  }
  if (!esObjeto(valor)) return undefined;
  for (const [k, v] of Object.entries(valor)) if ((k === 'id' || k.endsWith('_id')) && v === id) return valor;
  for (const v of Object.values(valor)) {
    const r = buscarPorId(v, id);
    if (r) return r;
  }
  return undefined;
}
