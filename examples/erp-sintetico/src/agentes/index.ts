import { RegistroAgentes } from '@agentic-erp/core';
import { AGENTE_CAJA } from './caja/agente.js';
import { AGENTE_COMPRAS } from './compras/agente.js';
import { AGENTE_STOCK } from './stock/agente.js';
import { AGENTE_VENTAS } from './ventas/agente.js';

export { COMUNES, leerPlaybook } from './comunes.js';
export { AGENTE_VENTAS, AGENTE_STOCK, AGENTE_COMPRAS, AGENTE_CAJA };

export const REGISTRO_AGENTES = new RegistroAgentes([AGENTE_VENTAS, AGENTE_STOCK, AGENTE_COMPRAS, AGENTE_CAJA]);
