import { RegistroAgentes } from '@agentic-erp/core';
import { AGENTE_CAJA } from './caja/agente.js';
import { AGENTE_COBRANZAS } from './cobranzas/agente.js';
import { AGENTE_COMPRAS } from './compras/agente.js';
import { AGENTE_FACTURACION } from './facturacion/agente.js';
import { AGENTE_PAGOS } from './pagos/agente.js';
import { AGENTE_STOCK } from './stock/agente.js';
import { AGENTE_VENTAS } from './ventas/agente.js';

export { COMUNES, leerPlaybook } from './comunes.js';
export { AGENTE_VENTAS, AGENTE_STOCK, AGENTE_COMPRAS, AGENTE_CAJA, AGENTE_FACTURACION, AGENTE_COBRANZAS, AGENTE_PAGOS };

export const REGISTRO_AGENTES = new RegistroAgentes([AGENTE_VENTAS, AGENTE_STOCK, AGENTE_COMPRAS, AGENTE_CAJA, AGENTE_FACTURACION, AGENTE_COBRANZAS, AGENTE_PAGOS]);
