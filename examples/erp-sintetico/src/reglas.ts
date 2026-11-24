import { Router, type DominioDef, type OpcionesRouter, type ReglaRouter } from '@agentic-erp/core';
import type { LlmProvider } from '@agentic-erp/llm';

/** Los dominios del ejemplo, en el orden en que se ejecutan cuando una frase toca varios. */
export const DOMINIOS: DominioDef[] = [
  { nombre: 'ventas', descripcion: 'Ventas, ingresos, margen, ranking de artículos, tendencias, indicadores y anomalías' },
  { nombre: 'stock', descripcion: 'Existencias, artículos bajo el mínimo, ficha de un artículo y ajustes de inventario' },
  { nombre: 'compras', descripcion: 'Proveedores, órdenes de compra, qué hay que comprar o reponer' },
  { nombre: 'caja', descripcion: 'Estado de la caja, movimientos de caja, arqueos, faltantes y sobrantes' },
  { nombre: 'facturacion', descripcion: 'Clientes, facturas de venta, saldo de cada factura, total facturado y notas de crédito' },
  { nombre: 'cobranzas', descripcion: 'Cuánto debe cada cliente (estado de cuenta, deudores, antigüedad de la deuda, límite de crédito) y registro de cobros' },
  { nombre: 'pagos', descripcion: 'Cuánto se le debe a cada proveedor (cuentas a pagar, vencimientos, agenda de pagos) y registro de pagos a proveedores' },
  { nombre: 'tesoreria', descripcion: 'Cuentas bancarias y sus movimientos, conciliación de los depósitos de caja con el banco, posición de tesorería y transferencias entre cuentas propias' },
  { nombre: 'precios', descripcion: 'Listas de precios (minorista, mayorista, distribuidores), precio y margen de cada artículo, historial de cambios de precio y cambios de precio' },
  { nombre: 'gestion', descripcion: 'Mirar el negocio entero: cierre del día, resumen de gestión del período y alertas que juntan lo que detectan las demás áreas (solo lectura)' },
];

/**
 * Reglas en español rioplatense. Se escriben sin tildes: el router normaliza el texto antes de probarlas.
 * Son deliberadamente estrechas: lo ambiguo lo resuelve el clasificador con el modelo.
 */
export const REGLAS: ReglaRouter[] = [
  // "¿hay algo raro?" abarca ventas y caja, pero lo resuelve un solo agente (detectar_anomalias cubre ambas áreas).
  { dominio: 'ventas', exclusiva: true, patron: /\banomali\w*|\balgo raro\b|\bdesvio\w*|\bfuera de lo normal\b|\bcaida de ventas\b/ },
  { dominio: 'ventas', patron: /\bventas?\b|\bvendi\w*|\bvendemos\b|\bingresos?\b|\bmargen\b|\branking\b|\bmas vendid\w*|\bmenos vendid\w*|\bkpis?\b|\btendencia\b|\bcomo vamos\b|\btop \d+/ },
  { dominio: 'stock', patron: /\bstock\b|\bexistencias?\b|\binventario\b|\bbajo(?: el)? minimo\b|\bquedan\b|\bcuantas? (?:unidades )?hay\b|\bhay de\b|\bconteo\b/ },
  { dominio: 'compras', patron: /\bcompras?\b|\bcomprar\b|\bordenes? de compra\b|\bproveedor\w*|\brepon\w*|\breposicion\b|\bpedido a\b|\bpedile a\b/ },
  { dominio: 'caja', patron: /\bcaja\b|\barqueo\w*|\bfaltante\w*|\bsobrante\w*|\bmovimientos? de caja\b|\bretiro\b|\bgastos? menores?\b/ },
  // «factur\w*» vive acá y no en ventas: facturar es facturación, y así «qué facturamos» no dispara dos agentes.
  { dominio: 'facturacion', patron: /\bfactur\w*|\bnotas? de credito\b|\bcomprobantes?\b/ },
  // Cobranzas: deuda de clientes y cobros. «cobrada/cobrado» (estado de una factura) queda en facturación; acá van los verbos y «cobro/cobranza».
  { dominio: 'cobranzas', patron: /\bcobros?\b|\bcobre\b|\bcobramos\b|\bcobranzas?\b|\bdeudor\w*|\bmoros\w*|\bnos deb\w*|\bcuanto deb\w*|\bestado de cuenta\b|\blimite de credito\b/ },
  // Pagos: «pagale/pagá/pagar» y los vencimientos de proveedores. «pagá las facturas vencidas» también dispara facturación por «factur\w*»: por eso la regla de pagar es exclusiva.
  { dominio: 'pagos', exclusiva: true, patron: /\bpagal[eo]s?\b|\bpaga\b|\bpagar\b|\bpagame\b/ },
  { dominio: 'pagos', patron: /\bpagos?\b|\bcuentas? a pagar\b|\bdebemos\b|\bvencimientos?\b/ },
  // Tesorería: «concili\w*» es exclusiva porque «conciliá los depósitos de caja» también dispara caja. Los bancos se nombran por su nombre propio.
  { dominio: 'tesoreria', exclusiva: true, patron: /\bconcili\w*/ },
  { dominio: 'tesoreria', patron: /\bbancos?\b|\bbancari\w*|\btesoreria\b|\bnacion\b|\bgalicia\b|\bsantander\b|\btransferi\w*|\btransferencias? internas?\b/ },
  // Precios y listas: «margen bajo» es exclusiva porque «margen» también dispara ventas; «precio» y «lista mayorista/minorista» no.
  { dominio: 'precios', exclusiva: true, patron: /\bmargen(?:es)? (?:bajos?|minimos?|negativos?)\b|\bbajo(?: el)? costo\b/ },
  { dominio: 'precios', patron: /\bprecios?\b|\blistas? (?:de precios?|minorista|mayorista|de distribuidores)\b|\bminorista\b|\bdistribuidores\b/ },
  // Gestión del día: el cierre, el resumen de gestión y las alertas cruzan varias áreas, por eso son exclusivas (un solo agente las resuelve).
  { dominio: 'gestion', exclusiva: true, patron: /\bcierre del dia\b|\bcerro (?:el )?dia\b|\bcerramos\b|\bresumen (?:del? )?(?:mes|dia|gestion|negocio)\b|\bque tengo que mirar\b|\balertas?\b/ },
];

export function crearRouter(llm?: LlmProvider): Router {
  const opciones: OpcionesRouter = {
    dominios: DOMINIOS,
    reglas: REGLAS,
    descripcionDelNegocio: 'El negocio vende artículos de oficina y tecnología en tienda y online; el ERP lleva ventas, stock, compras, caja, facturación a clientes, cobranzas, pagos a proveedores, tesorería (cuentas bancarias), listas de precios y la gestión del día (cierre, resumen y alertas).',
    ...(llm ? { llm } : {}),
  };
  return new Router(opciones);
}
