import { Herramientas, Orquestador, Trace, type OpcionesOrquestador } from '@agentic-erp/core';
import type { LlmProvider } from '@agentic-erp/llm';
import { ClienteMcp } from '@agentic-erp/mcp-client';
import type { ContextoSesion } from '@agentic-erp/mcp-contract';
import { REGISTRO_AGENTES } from './agentes.js';
import { HOY } from './datos.js';
import type { ErpSintetico, OpcionesErp } from './erp.js';
import { permisosDelEjemplo } from './permisos.js';
import { crearRouter } from './reglas.js';
import { crearServidorMcp } from './servidor.js';

/** Contexto de sesión de ejemplo. El rol define qué escrituras puede preparar. */
export const contextoDe = (rol: string, usuario = `${rol}1`): ContextoSesion => ({ tenant: 'demo', usuario, rol });

export const PIN_SUPERVISOR_DE_PRUEBA = '2468';

export interface Despliegue {
  orquestador: Orquestador;
  erp: ErpSintetico;
  trace: Trace;
  cliente: ClienteMcp;
  herramientas: Herramientas;
  cerrar(): Promise<void>;
}

export interface OpcionesDespliegue {
  llm: LlmProvider;
  /** Proveedor del router para lo que las reglas no cubren. Por defecto, el mismo `llm`. */
  llmRouter?: LlmProvider | null;
  erp?: OpcionesErp;
  orquestador?: Partial<OpcionesOrquestador>;
  trace?: Trace;
}

/**
 * Arma todo el ejemplo en memoria: servidor MCP del ERP sintético, cliente MCP real (con el protocolo de por medio),
 * herramientas, router, agentes y orquestador. Lo usan las pruebas, los evals y la demo.
 */
export async function crearDespliegue(o: OpcionesDespliegue): Promise<Despliegue> {
  const reloj = o.erp?.reloj ?? (() => new Date(`${HOY}T12:00:00.000Z`));
  const { servidor, erp } = crearServidorMcp({ reloj, autorizadores: { supervisor1: { pin: PIN_SUPERVISOR_DE_PRUEBA, rol: 'supervisor' } }, ...o.erp });
  const cliente = await ClienteMcp.enMemoria(servidor);
  const herramientas = await Herramientas.desde(cliente);
  const trace = o.trace ?? new Trace();
  const llmRouter = o.llmRouter === null ? undefined : (o.llmRouter ?? o.llm);
  const orquestador = new Orquestador({
    router: crearRouter(llmRouter),
    agentes: REGISTRO_AGENTES,
    llm: o.llm,
    herramientas,
    permisos: permisosDelEjemplo(),
    trace,
    reloj,
    contextoDelNegocio: () => `FECHA DE REFERENCIA DEL NEGOCIO: hoy es ${HOY} (martes). Moneda: USD. Hay datos desde 2026-01-01.`,
    ...o.orquestador,
  });
  return {
    orquestador,
    erp,
    trace,
    cliente,
    herramientas,
    cerrar: async () => {
      await cliente.cerrar();
      await servidor.close();
    },
  };
}
