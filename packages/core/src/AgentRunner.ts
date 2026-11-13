import { LlmError, type LlmMessage, type LlmProvider, type LlmToolCall, type LlmToolResult } from '@agentic-erp/llm';
import { esConfirmar, esPreparar, type ContextoSesion } from '@agentic-erp/mcp-contract';
import { MAX_PASOS_POR_AGENTE, type AgentConfig } from './agentes.js';
import type { AccionCatalogo, Compositor, Sobre } from './Compositor.js';
import { declaracionesFinales, esFinal, parsearDirectiva, type Directiva } from './directivas.js';
import type { Herramientas } from './Herramientas.js';
import type { MemoriaIntencion } from './memoria.js';
import type { Permisos } from './permisos.js';
import { ProposalStore } from './ProposalStore.js';
import { resumenResultado, type Trace } from './trace.js';
import { clonar, type Obj } from './util.js';

/** Códigos que el orquestador mismo le pide a los agentes (el prompt común los nombra). */
export const CODIGOS_PROPIOS: ReadonlySet<string> = new Set(['AGENTE_SIN_RESOLUCION', 'PERMISO_DENEGADO']);

/** Lo que el agente necesita saber de la intención en curso. */
export interface ContextoIntencion {
  intentId: string;
  traceId: string;
  memoria: MemoriaIntencion;
  /** Historial de mensajes por agente: dentro de una intención (por ejemplo tras una aclaración) el agente retoma su hilo. */
  historiales: Map<string, LlmMessage[]>;
  /** Códigos de error devueltos por tools en esta intención: un report_error solo puede usar uno de estos. */
  codigos: Set<string>;
  /** Acción sugerida (apta para personas) que dio el servidor para cada código. */
  accionesServidor?: Map<string, string>;
  /** La persona canceló la intención en curso: el loop corta entre pasos. */
  senal?: AbortSignal;
}

export interface SalidaAgente {
  sobre: Sobre;
  /** true si el agente terminó en error (modelo caído, tope de pasos, validación fallida dos veces, report_error). */
  esError: boolean;
  codigoError?: string;
  componente: string;
  /** true si la persona canceló mientras el agente trabajaba. */
  cancelado?: boolean;
  fuenteId?: string;
  acciones: AccionCatalogo[];
  opciones?: { id: string; etiqueta: string }[];
}

export interface DepsRunner {
  llm: LlmProvider;
  herramientas: Herramientas;
  trace: Trace;
  permisos?: Permisos;
  maxPasos?: number;
}

const CANCELADA = Symbol('cancelada');

/**
 * Loop de un agente de dominio (ADR-002): llama tools de lectura y preparar_* y termina SIEMPRE con una
 * directiva final (render_ui, clarify o report_error). Todo lo que el modelo ve pasa por ProposalStore.paraLlm.
 */
export class AgentRunner {
  constructor(private readonly deps: DepsRunner) {}

  async ejecutar(agente: AgentConfig, intencion: ContextoIntencion, contexto: ContextoSesion, store: ProposalStore, compositor: Compositor, entrada: string, contextoNegocio?: string): Promise<SalidaAgente> {
    const { trace, llm, herramientas } = this.deps;
    const maxPasos = agente.maxPasos ?? this.deps.maxPasos ?? MAX_PASOS_POR_AGENTE;
    const ctxComp = { intentId: intencion.intentId, traceId: intencion.traceId, agente: agente.nombre, componentesPermitidos: agente.componentes };
    const t = (evento: string, datos: Record<string, unknown> = {}): void => trace.registrar(intencion.traceId, intencion.intentId, evento, { agente: agente.nombre, ...datos });

    const hist = intencion.historiales.get(agente.nombre) ?? [];
    intencion.historiales.set(agente.nombre, hist);
    hist.push({ role: 'user', text: entrada });

    // El modelo solo ve las tools que existen en el servidor y que el rol puede usar.
    const disponibles = agente.tools.filter((n) => herramientas.existe(n) && (this.deps.permisos?.puede(n, contexto.rol) ?? true));
    t('agente_inicio', { tools: disponibles.length });

    const error = (codigo: string, mensaje: string, accion?: string, reintentable?: boolean): SalidaAgente => {
      t('agente_error', { codigo });
      return { sobre: compositor.sobreError(ctxComp, codigo, mensaje, accion, reintentable), esError: true, codigoError: codigo, componente: 'ErrorNotice', acciones: [] };
    };
    if (disponibles.length === 0) return error('SIN_HERRAMIENTAS', 'No tenés acceso a ninguna herramienta de esta área.', 'Pedí el permiso a quien administra el sistema.', false);

    const sistema = contextoNegocio ? `${agente.systemPrompt}\n\n${contextoNegocio}` : agente.systemPrompt;
    const tools = [...herramientas.declaracionesPara(disponibles), ...declaracionesFinales(agente.componentes)];
    let reintentosValidacion = 0;

    const cancelada = (): boolean => intencion.senal?.aborted === true;
    const salidaCancelada = (): SalidaAgente => {
      t('agente_cancelado');
      return { sobre: compositor.sobreToast(ctxComp, 'info', 'Cancelado'), esError: false, cancelado: true, componente: 'StatusToast', acciones: [] };
    };
    /** La llamada al modelo no se puede abortar de verdad: se deja de esperarla en cuanto la persona cancela. */
    const hastaCancelar = async <T>(p: Promise<T>): Promise<T | typeof CANCELADA> => {
      const senal = intencion.senal;
      if (!senal) return p;
      if (senal.aborted) return CANCELADA;
      let alAbortar: (() => void) | undefined;
      const abortada = new Promise<typeof CANCELADA>((res) => {
        alAbortar = () => res(CANCELADA);
        senal.addEventListener('abort', alAbortar, { once: true });
      });
      try {
        return await Promise.race([p, abortada]);
      } finally {
        if (alAbortar) senal.removeEventListener('abort', alAbortar);
        p.catch(() => undefined);
      }
    };

    for (let paso = 1; paso <= maxPasos; paso++) {
      if (cancelada()) return salidaCancelada();
      let respuesta;
      try {
        const r = await hastaCancelar(llm.generate({ system: sistema, messages: hist, tools, toolMode: 'any', etiqueta: `agente:${agente.nombre}` }));
        if (r === CANCELADA) return salidaCancelada();
        respuesta = r;
      } catch (e) {
        t('llm_error', { mensaje: e instanceof Error ? e.message : String(e) });
        if (e instanceof LlmError && e.codigo === 'PRESUPUESTO_AGOTADO') return error('PRESUPUESTO_AGOTADO', 'Se agotó el presupuesto del asistente.', 'Avisar a quien administra el sistema.', false);
        return error('LLM_NO_DISPONIBLE', 'No pude consultar al asistente en este momento. Probá de nuevo en unos segundos.', 'Reintentar el pedido.', true);
      }
      if (cancelada()) return salidaCancelada();
      t('llm_respuesta', { paso, llamadas: respuesta.toolCalls.map((c) => c.name), texto: respuesta.text ? true : false });
      hist.push({ role: 'assistant', toolCalls: respuesta.toolCalls, ...(respuesta.text ? { text: respuesta.text } : {}), ...(respuesta.raw !== undefined ? { raw: respuesta.raw } : {}) });

      if (respuesta.toolCalls.length === 0) {
        hist.push({ role: 'user', text: 'Tenés que terminar llamando a render_ui, clarify o report_error. No contestes con texto suelto.' });
        continue;
      }

      const resultados: LlmToolResult[] = [];
      let salida: SalidaAgente | undefined;
      for (const call of respuesta.toolCalls) {
        if (salida) {
          resultados.push({ callId: call.id, name: call.name, result: { ignorada: true } });
          continue;
        }
        if (esFinal(call.name)) {
          const parsed = parsearDirectiva(call.name, call.args);
          let errores: string[];
          if (!parsed.ok) {
            errores = [parsed.error];
          } else {
            const directiva = this.conAccionDelServidor(this.sanearCodigo(parsed.directiva, intencion.codigos, t), intencion);
            const comp = compositor.componer(directiva, ctxComp);
            if (comp.ok) {
              for (const d of comp.descartes) t('campo_descartado', { campo: d.campo, motivo: d.motivo });
              t('directiva_final', { directiva: directiva.tipo, componente: comp.sobre['component'], fuente: comp.fuenteId, valida: true });
              const esError = directiva.tipo === 'report_error';
              salida = {
                sobre: comp.sobre,
                esError,
                ...(esError ? { codigoError: directiva.codigo } : {}),
                componente: String(comp.sobre['component']),
                ...(comp.fuenteId ? { fuenteId: comp.fuenteId } : {}),
                acciones: comp.acciones,
                ...(comp.opciones ? { opciones: comp.opciones } : {}),
              };
              resultados.push({ callId: call.id, name: call.name, result: { ok: true, mostrado: true } });
              continue;
            }
            errores = comp.errores;
          }
          t('validacion_fallida', { errores, reintento: reintentosValidacion });
          if (reintentosValidacion >= 1) return error('UI_INVALIDA', 'No pude armar la pantalla para esto. Probá reformulando el pedido.', undefined, true);
          reintentosValidacion++;
          resultados.push({
            callId: call.id,
            name: call.name,
            result: { ok: false, errores, instruccion: 'Corregí y volvé a llamar a una función final (render_ui, clarify o report_error). Es el único reintento.' },
          });
          continue;
        }
        if (cancelada()) return salidaCancelada();
        resultados.push(await this.llamarTool(agente, disponibles, call, intencion, contexto, store, t));
      }
      hist.push({ role: 'tool', results: resultados });
      if (salida) return salida;
    }
    return error('TOPE_DE_PASOS', 'No logré resolverlo en los pasos permitidos. Reformulalo más concreto.', 'Volver a pedirlo.', true);
  }

  /** El modelo suele reescribir el error con sus palabras y perder lo concreto: la acción sugerida del servidor para la persona gana. */
  private conAccionDelServidor(d: Directiva, intencion: ContextoIntencion): Directiva {
    const accion = d.tipo === 'report_error' ? intencion.accionesServidor?.get(d.codigo) : undefined;
    return accion && d.tipo === 'report_error' ? { ...d, accion_sugerida: accion } : d;
  }

  /** report_error solo puede usar códigos que devolvió un tool en esta intención, o AGENTE_SIN_RESOLUCION. Un código inventado se reemplaza y queda en la traza. */
  private sanearCodigo(d: Directiva, vistos: ReadonlySet<string>, t: (evento: string, datos?: Record<string, unknown>) => void): Directiva {
    const valido = (c: string): boolean => CODIGOS_PROPIOS.has(c) || vistos.has(c);
    if (d.tipo === 'report_error' && !valido(d.codigo)) {
      t('codigo_error_inventado', { original: d.codigo, usado: 'AGENTE_SIN_RESOLUCION' });
      return { ...d, codigo: 'AGENTE_SIN_RESOLUCION' };
    }
    return d;
  }

  private async llamarTool(
    agente: AgentConfig,
    disponibles: readonly string[],
    call: LlmToolCall,
    intencion: ContextoIntencion,
    contexto: ContextoSesion,
    store: ProposalStore,
    t: (evento: string, datos?: Record<string, unknown>) => void,
  ): Promise<LlmToolResult> {
    const { herramientas } = this.deps;
    const bloqueada = (motivo: string, mensaje: string, codigo = 'TOOL_NO_PERMITIDA'): LlmToolResult => {
      t('tool_bloqueada', { tool: call.name, motivo });
      return { callId: call.id, name: call.name, result: { codigo, mensaje, accion_sugerida: 'Usá solo los tools de tu lista y terminá con render_ui, clarify o report_error.' } };
    };
    // Los confirmar_* no existen para el modelo: los llama solo el orquestador tras un toque humano.
    if (esConfirmar(call.name)) return bloqueada('confirmar_no_expuesto', 'Ese tool no está disponible: las confirmaciones las hace la persona tocando el botón en pantalla.');
    if (!agente.tools.includes(call.name)) return bloqueada('fuera_del_dominio', `El tool ${call.name} no pertenece a tu dominio.`);
    if (!disponibles.includes(call.name)) return bloqueada('sin_permiso_o_inexistente', `No tenés permiso para usar ${call.name}.`, 'PERMISO_DENEGADO');

    t('tool_llamada', { tool: call.name, args: clonar(call.args) });
    const { resultado, argsLimpios, reservadosDescartados } = await herramientas.invocar(call.name, call.args, contexto, { intentId: intencion.intentId, callId: call.id });
    if (reservadosDescartados.length) t('campos_reservados_descartados', { tool: call.name, campos: reservadosDescartados });

    if (!resultado.ok) {
      const codigo = resultado.datos['codigo'];
      if (typeof codigo === 'string') {
        intencion.codigos.add(codigo);
        const accion = resultado.datos['accion_sugerida'];
        // "Probá con otro período." es para la persona; "Verificá con listar_x." es para el modelo y no se muestra.
        if (typeof accion === 'string' && accion.trim() && !/\b[a-z]+_[a-z_]+\b/.test(accion)) (intencion.accionesServidor ??= new Map()).set(codigo, accion.trim());
      }
      t('tool_error', { tool: call.name, resultado: resumenResultado(resultado.datos) });
      return { callId: call.id, name: call.name, result: resultado.datos };
    }

    const salida: Obj = resultado.datos;
    intencion.memoria.absorber(salida);
    if (esPreparar(call.name) && typeof salida['proposal_id'] === 'string' && typeof salida['confirmation_token'] === 'string') {
      const fuente = store.guardarPropuesta(call.name, argsLimpios, salida, intencion.intentId, agente.nombre);
      t('propuesta_guardada', { tool: call.name, proposal_id: fuente.id });
      return { callId: call.id, name: call.name, result: ProposalStore.paraLlm(salida) };
    }
    const fuente = store.guardarLectura(call.name, argsLimpios, salida, intencion.intentId, agente.nombre);
    t('tool_ok', { tool: call.name, resultado: resumenResultado(salida), source_id: fuente.id });
    return { callId: call.id, name: call.name, result: ProposalStore.paraLlm(salida, fuente) };
  }
}
