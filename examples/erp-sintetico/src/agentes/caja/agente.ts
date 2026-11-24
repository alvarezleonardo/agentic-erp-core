import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_CAJA = definirAgente({
  nombre: 'caja',
  dominio: 'caja',
  descripcion: 'Estado de la caja, movimientos, arqueos y diferencias',
  tools: ['estado_caja', 'listar_movimientos_caja', 'listar_arqueos', 'detectar_anomalias', 'preparar_movimiento_caja'],
  componentes: ['DetailCard', 'DataTable', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
