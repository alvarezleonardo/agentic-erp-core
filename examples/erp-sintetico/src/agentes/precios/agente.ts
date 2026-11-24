import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_PRECIOS = definirAgente({
  nombre: 'precios',
  dominio: 'precios',
  descripcion: 'Listas de precios, márgenes, historial de precios y cambios de precio',
  tools: ['buscar_articulos', 'listar_precios', 'historial_precios', 'articulos_margen_bajo', 'preparar_cambio_precio'],
  componentes: ['DataTable', 'DetailCard', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
