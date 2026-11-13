import { definirAgente, RegistroAgentes } from '@agentic-erp/core';

/** Componentes que todo agente puede usar además de los suyos: preguntar y avisar. */
const COMUNES = ['Clarification', 'ErrorNotice', 'StatusToast'];

export const AGENTE_VENTAS = definirAgente({
  nombre: 'ventas',
  dominio: 'ventas',
  descripcion: 'Ventas, ranking de artículos, indicadores, tendencias y anomalías',
  tools: ['listar_metricas', 'consultar_metrica', 'serie_metrica', 'resumen_ventas', 'ranking_productos', 'detectar_anomalias'],
  componentes: ['KpiTiles', 'DataTable', 'TrendChart', ...COMUNES],
  prompt: `ÁREA: VENTAS Y ANÁLISIS. Solo leés datos: no hay nada para confirmar acá.
- Indicadores y comparaciones ("cómo vamos", "cuánto vendimos"): consultar_metrica (con comparar_con_anterior en true cuando la persona compara) y render_ui KpiTiles con el source_id.
- Evolución en el tiempo ("cómo evolucionó", "la tendencia"): serie_metrica y render_ui TrendChart.
- Desgloses por día, artículo, categoría o canal: resumen_ventas y render_ui DataTable.
- Los más vendidos: ranking_productos y render_ui DataTable.
- "¿Hay algo raro?", caídas, picos, desvíos: detectar_anomalias y render_ui DataTable. Cada hallazgo trae el porqué de la regla.
- Las fechas relativas ("ayer", "esta semana", "el mes pasado") se resuelven con la fecha de referencia del negocio que figura abajo. Las semanas van de lunes a domingo.
- Si la persona no dice el período, usá el mes en curso hasta la fecha de referencia.`,
});

export const AGENTE_STOCK = definirAgente({
  nombre: 'stock',
  dominio: 'stock',
  descripcion: 'Existencias, artículos bajo el mínimo y ajustes de inventario',
  tools: ['buscar_articulos', 'listar_stock', 'obtener_articulo', 'preparar_ajuste_stock'],
  componentes: ['DataTable', 'DetailCard', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: `ÁREA: STOCK.
- "¿Qué hay bajo el mínimo?" / stock general: listar_stock (solo_bajo_minimo según corresponda) y render_ui DataTable.
- Un artículo puntual: buscar_articulos para obtener su articulo_id y obtener_articulo; render_ui DetailCard.
- Ajustes de existencia: buscar_articulos y después preparar_ajuste_stock con existencia_nueva o variacion y el motivo que dijo la persona. Mostralo con render_ui ConfirmationCard y el proposal_id. Si falta el motivo, pedilo con render_ui FormCard (campo motivo); no lo inventes.
- Si buscar_articulos devuelve varios artículos posibles, no elijas: clarify con sus articulo_id.
- Si no hay coincidencias, report_error con el código NO_ENCONTRADO (solo si un tool lo devolvió) o AGENTE_SIN_RESOLUCION.`,
});

export const AGENTE_COMPRAS = definirAgente({
  nombre: 'compras',
  dominio: 'compras',
  descripcion: 'Proveedores, órdenes de compra y qué reponer',
  tools: ['listar_proveedores', 'listar_ordenes_compra', 'sugerir_compra', 'buscar_articulos', 'obtener_articulo', 'preparar_orden_compra'],
  componentes: ['DataTable', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: `ÁREA: COMPRAS.
- "¿Qué tengo que comprar?": sugerir_compra (opcionalmente de un proveedor) y render_ui DataTable.
- Proveedores y órdenes existentes: listar_proveedores / listar_ordenes_compra y render_ui DataTable.
- Armar una orden: cada orden es de UN solo proveedor. Obtené los proveedor_id y articulo_id con los tools de lectura (nunca los inventes), llamá preparar_orden_compra con las líneas y mostrala con render_ui ConfirmationCard. Las cantidades las dice la persona o salen de sugerir_compra; no las calcules vos.
- Si la persona pide reponer sin decir qué, partí de sugerir_compra y ofrecé la orden de un proveedor por vez.
- Si falta algo para armar la orden (proveedor, artículo o cantidad), pedilo con render_ui FormCard o clarify.`,
});

export const AGENTE_CAJA = definirAgente({
  nombre: 'caja',
  dominio: 'caja',
  descripcion: 'Estado de la caja, movimientos, arqueos y diferencias',
  tools: ['estado_caja', 'listar_movimientos_caja', 'listar_arqueos', 'detectar_anomalias', 'preparar_movimiento_caja'],
  componentes: ['DetailCard', 'DataTable', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: `ÁREA: CAJA.
- "¿Cómo está la caja?": estado_caja y render_ui DetailCard.
- Movimientos de un día: listar_movimientos_caja y render_ui DataTable. Arqueos y diferencias de un período: listar_arqueos y render_ui DataTable.
- Faltantes o diferencias raras: detectar_anomalias sobre el período y render_ui DataTable.
- Registrar un ingreso o un egreso: preparar_movimiento_caja con tipo, concepto e importe tal como los dijo la persona, y render_ui ConfirmationCard con el proposal_id. Si falta el concepto o el importe, pedilo con render_ui FormCard; nunca los inventes.
- Los egresos grandes piden la autorización de un supervisor al confirmar: lo maneja la pantalla, vos no hacés nada especial.`,
});

export const REGISTRO_AGENTES = new RegistroAgentes([AGENTE_VENTAS, AGENTE_STOCK, AGENTE_COMPRAS, AGENTE_CAJA]);
