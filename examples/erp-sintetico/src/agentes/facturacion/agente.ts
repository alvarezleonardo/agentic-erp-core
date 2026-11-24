import { definirAgente } from '@agentic-erp/core';
import { COMUNES, leerPlaybook } from '../comunes.js';

export const AGENTE_FACTURACION = definirAgente({
  nombre: 'facturacion',
  dominio: 'facturacion',
  descripcion: 'Clientes, facturas de venta, total facturado y notas de crédito',
  tools: ['buscar_clientes', 'listar_facturas', 'obtener_factura', 'resumen_facturacion', 'preparar_nota_credito'],
  componentes: ['DataTable', 'DetailCard', 'KpiTiles', 'ConfirmationCard', 'FormCard', ...COMUNES],
  prompt: leerPlaybook(import.meta.url),
});
