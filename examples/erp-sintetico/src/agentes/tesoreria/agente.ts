import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_TESORERIA = definirAgente({
  nombre: 'tesoreria',
  dominio: 'tesoreria',
  descripcion: 'Bancos, conciliación de depósitos, posición de tesorería y transferencias',
  tools: ['listar_cuentas_bancarias', 'listar_movimientos_bancarios', 'conciliar_depositos', 'posicion_tesoreria', 'preparar_transferencia_interna'],
  componentes: ['DataTable', 'KpiTiles', 'DetailCard', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
