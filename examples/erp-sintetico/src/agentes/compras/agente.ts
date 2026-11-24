import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_COMPRAS = definirAgente({
  nombre: 'compras',
  dominio: 'compras',
  descripcion: 'Proveedores, órdenes de compra y qué reponer',
  tools: ['listar_proveedores', 'listar_ordenes_compra', 'sugerir_compra', 'buscar_articulos', 'obtener_articulo', 'preparar_orden_compra'],
  componentes: ['DataTable', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
