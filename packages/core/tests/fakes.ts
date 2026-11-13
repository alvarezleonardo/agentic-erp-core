import type { ContextoSesion, Obj, ResultadoTool, ToolClient, ToolMcp } from '@agentic-erp/mcp-contract';
import { ContractValidator, Compositor, ProposalStore, Trace, definirAgente, type AgentConfig, type ContextoIntencion, MemoriaIntencion } from '../src/index.js';

export const CTX: ContextoSesion = { tenant: 't1', usuario: 'ana', rol: 'operador' };
export const AHORA = new Date('2026-03-31T12:00:00.000Z');

const esquema = (props: Obj = {}, required: string[] = []): Obj => ({ type: 'object', properties: { contexto: { type: 'object' }, ...props }, required: ['contexto', ...required] });

export const TOOLS_FALSAS: ToolMcp[] = [
  { nombre: 'leer_tabla', descripcion: 'Devuelve una tabla.', esquema: esquema({ filtro: { type: 'string' } }) },
  { nombre: 'leer_error', descripcion: 'Falla siempre.', esquema: esquema() },
  { nombre: 'preparar_cosa', descripcion: 'Prepara una cosa. Devuelve proposal_id y un confirmation_token.', esquema: esquema({ cantidad: { type: 'integer' } }) },
  { nombre: 'confirmar_cosa', descripcion: 'Confirma.', esquema: esquema({ proposal_id: {}, confirmation_token: {}, idempotency_key: {}, autorizacion: {} }, ['proposal_id', 'confirmation_token', 'idempotency_key']) },
];

export interface LlamadaFalsa {
  nombre: string;
  args: Obj;
  contexto: ContextoSesion | undefined;
}

/** Servidor falso mínimo: registra las llamadas y responde con lo que se le configure. */
export class ClienteFalso implements ToolClient {
  readonly llamadas: LlamadaFalsa[] = [];
  contador = 0;
  /** Respuesta de confirmar_cosa; por defecto confirma. */
  alConfirmar: (args: Obj) => ResultadoTool = () => ({ ok: true, datos: { estado: 'confirmado', idempotente: false, resultado: { id: 'x' }, mensaje: 'Cosa confirmada.' } });
  expira = '2026-03-31T12:10:00.000Z';
  requiereStepUp = false;
  /** Nivel de step-up que declara la propuesta (campo `step_up`); si está, manda sobre `requiereStepUp`. */
  stepUp: string | undefined;

  async listarTools(): Promise<ToolMcp[]> {
    return TOOLS_FALSAS;
  }

  async llamar(nombre: string, args: Obj, contexto: ContextoSesion | undefined): Promise<ResultadoTool> {
    this.llamadas.push({ nombre, args: structuredClone(args), contexto: structuredClone(contexto) });
    if (nombre === 'leer_tabla') {
      return { ok: true, datos: { titulo: 'Cosas', columnas: [{ id: 'cosa_id', etiqueta: 'Código' }, { id: 'nombre', etiqueta: 'Nombre' }], filas: [{ cosa_id: 'c1', nombre: 'Uno' }, { cosa_id: 'c2', nombre: 'Dos' }], total_filas: 2 } };
    }
    if (nombre === 'leer_error') return { ok: false, datos: { codigo: 'NO_ENCONTRADO', mensaje: 'No hay nada.', accion_sugerida: 'Probá con otro nombre.' } };
    if (nombre === 'preparar_cosa') {
      const n = ++this.contador;
      return {
        ok: true,
        datos: {
          proposal_id: `prop_${n}`,
          confirmation_token: `cft_secreto_${n}_0123456789abcdef`,
          expira_en: this.expira,
          titulo: 'Cosa a crear',
          total: { monto: '84.60', moneda: 'USD' },
          ...(this.requiereStepUp ? { requiere_step_up: true } : {}),
          ...(this.stepUp ? { step_up: this.stepUp } : {}),
        },
      };
    }
    if (nombre === 'confirmar_cosa') return this.alConfirmar(args);
    return { ok: false, datos: { codigo: 'TOOL_DESCONOCIDA', mensaje: nombre } };
  }

  async cerrar(): Promise<void> {}
}

export const agenteDePrueba = (extra: Partial<AgentConfig> = {}): AgentConfig => ({
  ...definirAgente({
    nombre: 'cosas',
    dominio: 'cosas',
    descripcion: 'Cosas',
    prompt: 'ÁREA: COSAS.',
    tools: ['leer_tabla', 'leer_error', 'preparar_cosa'],
    componentes: ['DataTable', 'ConfirmationCard', 'Clarification', 'ErrorNotice', 'StatusToast', 'FormCard'],
  }),
  ...extra,
});

export function bancoDeCompositor() {
  const store = new ProposalStore(() => AHORA.getTime());
  const validador = new ContractValidator();
  const compositor = new Compositor('ses_test', validador, store, () => AHORA);
  const ctxComp = { intentId: 'int_a', traceId: 'tr_a', agente: 'cosas', componentesPermitidos: agenteDePrueba().componentes };
  return { store, validador, compositor, ctxComp };
}

export const nuevaIntencion = (intentId = 'int_a'): ContextoIntencion => ({ intentId, traceId: 'tr_a', memoria: new MemoriaIntencion(), historiales: new Map(), codigos: new Set() });

export const nuevoTrace = (): Trace => new Trace({ reloj: () => AHORA });
