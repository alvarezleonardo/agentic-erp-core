import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_VENTAS = definirAgente({
  nombre: 'ventas',
  dominio: 'ventas',
  descripcion: 'Ventas, ranking de artículos, indicadores, tendencias y anomalías',
  tools: ['listar_metricas', 'consultar_metrica', 'serie_metrica', 'resumen_ventas', 'ranking_productos', 'detectar_anomalias'],
  componentes: ['KpiTiles', 'DataTable', 'TrendChart', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
