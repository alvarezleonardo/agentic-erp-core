import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_STOCK = definirAgente({
  nombre: 'stock',
  dominio: 'stock',
  descripcion: 'Existencias, artículos bajo el mínimo y ajustes de inventario',
  tools: ['buscar_articulos', 'listar_stock', 'obtener_articulo', 'preparar_ajuste_stock'],
  componentes: ['DataTable', 'DetailCard', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
