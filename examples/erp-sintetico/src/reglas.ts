import { Router, type DominioDef, type OpcionesRouter, type ReglaRouter } from '@agentic-erp/core';
import type { LlmProvider } from '@agentic-erp/llm';

/** Los dominios del ejemplo, en el orden en que se ejecutan cuando una frase toca varios. */
export const DOMINIOS: DominioDef[] = [
  { nombre: 'ventas', descripcion: 'Ventas, ingresos, margen, ranking de artículos, tendencias, indicadores y anomalías' },
  { nombre: 'stock', descripcion: 'Existencias, artículos bajo el mínimo, ficha de un artículo y ajustes de inventario' },
  { nombre: 'compras', descripcion: 'Proveedores, órdenes de compra, qué hay que comprar o reponer' },
  { nombre: 'caja', descripcion: 'Estado de la caja, movimientos de caja, arqueos, faltantes y sobrantes' },
];

/**
 * Reglas en español rioplatense. Se escriben sin tildes: el router normaliza el texto antes de probarlas.
 * Son deliberadamente estrechas: lo ambiguo lo resuelve el clasificador con el modelo.
 */
export const REGLAS: ReglaRouter[] = [
  // "¿hay algo raro?" abarca ventas y caja, pero lo resuelve un solo agente (detectar_anomalias cubre ambas áreas).
  { dominio: 'ventas', exclusiva: true, patron: /\banomali\w*|\balgo raro\b|\bdesvio\w*|\bfuera de lo normal\b|\bcaida de ventas\b/ },
  { dominio: 'ventas', patron: /\bventas?\b|\bvendi\w*|\bvendemos\b|\bfactur\w*|\bingresos?\b|\bmargen\b|\branking\b|\bmas vendid\w*|\bmenos vendid\w*|\bkpis?\b|\btendencia\b|\bcomo vamos\b|\btop \d+/ },
  { dominio: 'stock', patron: /\bstock\b|\bexistencias?\b|\binventario\b|\bbajo(?: el)? minimo\b|\bquedan\b|\bcuantas? (?:unidades )?hay\b|\bhay de\b|\bconteo\b/ },
  { dominio: 'compras', patron: /\bcompras?\b|\bcomprar\b|\bordenes? de compra\b|\bproveedor\w*|\brepon\w*|\breposicion\b|\bpedido a\b|\bpedile a\b/ },
  { dominio: 'caja', patron: /\bcaja\b|\barqueo\w*|\bfaltante\w*|\bsobrante\w*|\bmovimientos? de caja\b|\bretiro\b|\bgastos? menores?\b/ },
];

export function crearRouter(llm?: LlmProvider): Router {
  const opciones: OpcionesRouter = {
    dominios: DOMINIOS,
    reglas: REGLAS,
    descripcionDelNegocio: 'El negocio vende artículos de oficina y tecnología en tienda y online; el ERP lleva ventas, stock, compras y caja.',
    ...(llm ? { llm } : {}),
  };
  return new Router(opciones);
}
