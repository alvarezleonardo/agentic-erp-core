import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_GESTION = definirAgente({
  nombre: 'gestion',
  dominio: 'gestion',
  descripcion: 'Gestión del día: cierre, resumen del período y alertas de todas las áreas',
  tools: ['cierre_del_dia', 'resumen_gestion', 'alertas_del_dia'],
  componentes: ['KpiTiles', 'DataTable', 'DetailCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
