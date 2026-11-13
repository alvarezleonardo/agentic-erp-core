import { randomInt } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { crearServidorMcp } from './servidor.js';

/**
 * Servidor MCP del ERP sintético por stdio. El PIN del supervisor de ejemplo sale de ERP_EJEMPLO_PIN_SUPERVISOR
 * o, si no está, se genera al azar en cada arranque y se informa por stderr (stdout es del protocolo).
 */
const pin = process.env['ERP_EJEMPLO_PIN_SUPERVISOR'] ?? String(randomInt(1000, 10_000));
const { servidor } = crearServidorMcp({ autorizadores: { supervisor1: { pin, rol: 'supervisor' } } });
await servidor.connect(new StdioServerTransport());
if (!process.env['ERP_EJEMPLO_PIN_SUPERVISOR']) console.error(`[erp-sintetico] autorizador de ejemplo: supervisor1 / PIN ${pin}`);
