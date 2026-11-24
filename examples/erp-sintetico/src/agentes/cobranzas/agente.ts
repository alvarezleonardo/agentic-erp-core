import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_COBRANZAS = definirAgente({
  nombre: 'cobranzas',
  dominio: 'cobranzas',
  descripcion: 'Estado de cuenta de clientes, deudores por antigüedad y registro de cobros',
  tools: ['buscar_clientes', 'estado_cuenta_cliente', 'listar_deudores', 'listar_cobranzas', 'preparar_cobranza'],
  componentes: ['DetailCard', 'DataTable', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
