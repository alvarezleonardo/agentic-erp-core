import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_PAGOS = definirAgente({
  nombre: 'pagos',
  dominio: 'pagos',
  descripcion: 'Cuentas a pagar a proveedores, vencimientos y registro de pagos',
  tools: ['buscar_proveedores', 'listar_cuentas_a_pagar', 'estado_cuenta_proveedor', 'vencimientos_proximos', 'listar_pagos_proveedor', 'preparar_pago_proveedor'],
  componentes: ['DetailCard', 'DataTable', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
