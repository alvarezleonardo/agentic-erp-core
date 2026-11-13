import type { LlmProvider } from '@agentic-erp/llm';
import { esConfirmar, esPreparar, type Autorizacion, type ContextoSesion } from '@agentic-erp/mcp-contract';
import { comandoDeMensaje, vistaPorDefecto, type Comando } from './comando.js';
import { AgentRunner, type ContextoIntencion, type SalidaAgente } from './AgentRunner.js';
import type { RegistroAgentes } from './agentes.js';
import { Compositor, type ContextoComposicion, type Sobre } from './Compositor.js';
import { Confirmador, type ResultadoConfirmacion } from './Confirmador.js';
import { ContractValidator } from './ContractValidator.js';
import type { Herramientas } from './Herramientas.js';
import { HIDRATADORES_BASE, type Hidratador } from './hidratacion.js';
import { MemoriaIntencion, MemoriaSesion } from './memoria.js';
import type { Permisos } from './permisos.js';
import { ProposalStore, type Fuente } from './ProposalStore.js';
import type { PlanRouter, Router } from './Router.js';
import { Trace } from './trace.js';
import { esObjeto, nuevoIntentId, nuevoSessionId, nuevoTraceId, type Obj } from './util.js';

export interface OpcionesOrquestador {
  router: Router;
  agentes: RegistroAgentes;
  llm: LlmProvider;
  herramientas: Herramientas;
  validador?: ContractValidator;
  permisos?: Permisos;
  trace?: Trace;
  maxPasos?: number;
  reloj?: () => Date;
  /** Política de step-up del despliegue, además de `requiere_step_up` que declara cada propuesta. */
  requiereStepUp?: (fuente: Fuente) => boolean;
  /** Hidratadores propios, además de los genéricos. */
  hidratadores?: Record<string, Hidratador>;
  /** Texto que se agrega al prompt de todos los agentes (por ejemplo la fecha de referencia del negocio). */
  contextoDelNegocio?: (contexto: ContextoSesion) => string;
  /**
   * Claves de entidad que NO cuentan como foco al recordar de qué se estaba hablando
   * (identificadores genéricos que aparecen en cualquier resultado). Por defecto `['id', 'tenant_id']`;
   * si la pasás, reemplaza la lista completa.
   */
  clavesIgnoradasEnMemoria?: string[];
  /**
   * Modo directo: componente con el que se muestra el resultado de una tool pedida por `comando` (tool -> componente).
   * El componente tiene que tener hidratador (los genéricos o los de `hidratadores`) y aceptar la salida de la tool.
   * Sin entrada para la tool, o si el componente no acepta su salida: `DetailCard` para un objeto y `DataTable` para
   * una lista. Los `preparar_*` siempre se muestran con `ConfirmationCard`.
   */
  componentesPorTool?: Readonly<Record<string, string>>;
}

export const CLAVES_IGNORADAS_EN_MEMORIA: readonly string[] = ['id', 'tenant_id'];

/** Qué pasó en la última corrida de una intención (para evals, pruebas y depuración). */
export interface CorridaIntencion {
  intentId: string;
  traceId: string;
  texto: string;
  plan: PlanRouter;
  salidas: { dominio: string; salida: SalidaAgente }[];
}

type Pendiente =
  | { tipo: 'dominio'; texto: string; ctx: ContextoIntencion }
  | { tipo: 'aclaracion'; ctx: ContextoIntencion; dominio: string; resto: string[]; texto: string; opciones: { id: string; etiqueta: string }[] };

/**
 * Un orquestador con agentes de dominio adentro (ADR-002): router -> agente(s) -> compositor. Los agentes no se
 * hablan entre sí; comparten la memoria de la intención. La persona decide: nada se escribe sin `ui.action` de confirmación.
 */
export class Orquestador {
  readonly trace: Trace;
  readonly validador: ContractValidator;

  constructor(readonly opciones: OpcionesOrquestador) {
    this.trace = opciones.trace ?? new Trace();
    this.validador = opciones.validador ?? new ContractValidator();
    const problemas = opciones.agentes.validarContraCatalogo(opciones.herramientas.nombres());
    if (problemas.length) throw new Error(`Los agentes no calzan con el servidor MCP:\n- ${problemas.join('\n- ')}`);
  }

  crearSesion(contexto: ContextoSesion): Sesion {
    return new Sesion(this, contexto);
  }
}

export class Sesion {
  readonly sessionId = nuevoSessionId();
  readonly store: ProposalStore;
  readonly compositor: Compositor;
  readonly memoria = new MemoriaSesion();
  /** Última corrida, para evals y pruebas. */
  ultimaCorrida: CorridaIntencion | undefined;

  private readonly runner: AgentRunner;
  private readonly confirmador: Confirmador;
  private readonly hidratadores: Readonly<Record<string, Hidratador>>;
  private pendiente: Pendiente | undefined;
  private intencionActual: { intentId: string; control: AbortController } | undefined;

  constructor(
    private readonly orq: Orquestador,
    readonly contexto: ContextoSesion,
  ) {
    const o = orq.opciones;
    const reloj = o.reloj ?? (() => new Date());
    this.store = new ProposalStore(() => reloj().getTime());
    this.hidratadores = o.hidratadores ? { ...HIDRATADORES_BASE, ...o.hidratadores } : HIDRATADORES_BASE;
    this.compositor = new Compositor(this.sessionId, orq.validador, this.store, reloj, this.hidratadores);
    this.runner = new AgentRunner({ llm: o.llm, herramientas: o.herramientas, trace: orq.trace, ...(o.permisos ? { permisos: o.permisos } : {}), ...(o.maxPasos ? { maxPasos: o.maxPasos } : {}) });
    this.confirmador = new Confirmador(this.store, o.herramientas, orq.trace, { reloj, ...(o.requiereStepUp ? { requiereStepUp: o.requiereStepUp } : {}) });
  }

  /** Punto de entrada único: recibe un mensaje de la superficie (validado contra client-message.schema.json) y devuelve los sobres que emite. */
  async manejar(msg: unknown): Promise<Sobre[]> {
    const v = this.orq.validador.validarMensajeCliente(msg);
    if (!v.ok) {
      const ctx = this.ctxOrquestador('int_invalido', 'tr_invalido');
      this.orq.trace.registrar('tr_invalido', 'int_invalido', 'mensaje_invalido', { errores: v.errores });
      return [this.compositor.sobreError(ctx, 'MENSAJE_INVALIDO', 'No pude interpretar el mensaje de la pantalla.', undefined, false)];
    }
    const m = msg as Obj;
    switch (m['type']) {
      case 'client.hello':
        this.compositor.soportados = esObjeto(m['supported_components']) ? (m['supported_components'] as Record<string, number[]>) : undefined;
        return [];
      case 'user.input': {
        const comando = comandoDeMensaje(m);
        return comando ? this.comando(comando, typeof m['text'] === 'string' ? m['text'] : `[directo] ${comando.tool}`) : this.texto(String(m['text']));
      }
      case 'ui.dismissed':
        return this.alDescartar(String(m['intent_id']), m['reason'] === 'user');
      default:
        return this.alAccionar(m);
    }
  }

  /** Atajo de `user.input`. */
  async texto(texto: string): Promise<Sobre[]> {
    // Una intención nueva retira lo anterior: las propuestas abiertas quedan abandonadas.
    if (this.intencionActual) this.store.abandonarIntencion(this.intencionActual.intentId);
    this.pendiente = undefined;
    const intentId = nuevoIntentId();
    const traceId = nuevoTraceId();
    const control = new AbortController();
    this.intencionActual = { intentId, control };
    const ctx: ContextoIntencion = { intentId, traceId, memoria: new MemoriaIntencion(), historiales: new Map(), codigos: new Set(), senal: control.signal };
    const emitidos: Sobre[] = [];
    const t = (evento: string, datos: Record<string, unknown> = {}): void => this.orq.trace.registrar(traceId, intentId, evento, datos);

    t('intencion_inicio', { texto, rol: this.contexto.rol });
    const plan = await this.orq.opciones.router.enrutar(texto);
    t('router', { plan: plan.plan, origen: plan.origen, ...(plan.motivo ? { motivo: plan.motivo } : {}) });
    this.ultimaCorrida = { intentId, traceId, texto, plan, salidas: [] };

    if (plan.plan.length === 0) {
      // Sin clasificar: se le pregunta a la persona en vez de adivinar.
      const dominios = this.orq.opciones.agentes.todos().map((a) => ({ id: a.dominio, etiqueta: a.descripcion }));
      this.pendiente = { tipo: 'dominio', texto, ctx };
      emitidos.push(this.compositor.sobreClarificacionFija(this.ctxOrquestador(intentId, traceId), '¿Con qué área querés trabajar?', dominios));
      return emitidos;
    }
    await this.ejecutarPlan(ctx, plan.plan, texto, texto, emitidos);
    return emitidos;
  }

  /**
   * Modo directo (protocolo 1.1): ejecuta una tool pedida por la superficie sin pasar por el modelo. Mismos permisos, misma
   * inyección de contexto e idempotencia que una corrida normal. Solo las tools que el modelo también podría usar (las de los agentes): un `confirmar_*` se rechaza
   * siempre (confirmar es el `ui.action` de la persona, que resuelve el Confirmador). Un `preparar_*` no ejecuta nada:
   * guarda la propuesta y muestra su ConfirmationCard como en una corrida normal.
   */
  async comando(cmd: Comando, descripcion: string): Promise<Sobre[]> {
    if (this.intencionActual) this.store.abandonarIntencion(this.intencionActual.intentId);
    this.pendiente = undefined;
    const intentId = nuevoIntentId();
    const traceId = nuevoTraceId();
    const control = new AbortController();
    this.intencionActual = { intentId, control };
    const { herramientas, permisos, agentes } = this.orq.opciones;
    const t = (evento: string, datos: Record<string, unknown> = {}): void => this.orq.trace.registrar(traceId, intentId, evento, datos);
    const dueno = agentes.todos().find((a) => a.tools.includes(cmd.tool));
    this.ultimaCorrida = { intentId, traceId, texto: descripcion, plan: { plan: dueno ? [dueno.dominio] : [], origen: 'comando', entidades: {} }, salidas: [] };
    t('intencion_inicio', { texto: descripcion, rol: this.contexto.rol, modo: 'directo' });
    t('comando_directo', { tool: cmd.tool, args: cmd.args });

    const ctxError = this.ctxOrquestador(intentId, traceId, dueno?.nombre ?? 'orquestador');
    const rechazar = (codigo: string, mensaje: string, accion?: string): Sobre[] => {
      t('comando_rechazado', { tool: cmd.tool, codigo });
      return [this.compositor.sobreError(ctxError, codigo, mensaje, accion, false)];
    };
    if (esConfirmar(cmd.tool)) return rechazar('COMANDO_NO_PERMITIDO', 'Confirmar no se puede pedir como comando: lo hace la persona desde la tarjeta de confirmación.');
    if (!herramientas.existe(cmd.tool) || !dueno) return rechazar('COMANDO_DESCONOCIDO', 'Esa operación no existe.');
    if (permisos && !permisos.puede(cmd.tool, this.contexto.rol)) return rechazar('PERMISO_DENEGADO', 'No tenés permiso para esa operación.', 'Pedile el permiso a quien administra el sistema.');

    const { resultado, argsLimpios, reservadosDescartados } = await herramientas.invocar(cmd.tool, cmd.args, this.contexto, { intentId, callId: `cmd_${intentId}` });
    if (reservadosDescartados.length) t('campos_reservados_descartados', { tool: cmd.tool, campos: reservadosDescartados });
    const ctxComp: ContextoComposicion = { intentId, traceId, agente: dueno.nombre, componentesPermitidos: [] };
    const cerrar = (sobre: Sobre, esError: boolean, componente: string, fuenteId?: string): Sobre[] => {
      this.ultimaCorrida?.salidas.push({ dominio: dueno.dominio, salida: { sobre, esError, componente, ...(fuenteId ? { fuenteId } : {}), acciones: [] } });
      return [sobre];
    };

    if (!resultado.ok) {
      const codigo = typeof resultado.datos['codigo'] === 'string' ? resultado.datos['codigo'] : 'COMANDO_FALLIDO';
      const accion = typeof resultado.datos['accion_sugerida'] === 'string' ? resultado.datos['accion_sugerida'] : undefined;
      t('tool_error', { tool: cmd.tool, codigo });
      const sobre = this.compositor.sobreError(ctxError, codigo, typeof resultado.datos['mensaje'] === 'string' ? resultado.datos['mensaje'] : 'No se pudo completar la operación.', accion, false);
      return cerrar(sobre, true, 'ErrorNotice');
    }

    const salida: Obj = resultado.datos;
    const memoria = new MemoriaIntencion();
    memoria.absorber(salida);
    let directiva: { componente: string; fuente: string; salida: Obj } | undefined;
    if (esPreparar(cmd.tool) && typeof salida['proposal_id'] === 'string' && typeof salida['confirmation_token'] === 'string') {
      const f = this.store.guardarPropuesta(cmd.tool, argsLimpios, salida, intentId, dueno.nombre);
      t('propuesta_guardada', { tool: cmd.tool, proposal_id: f.id });
      directiva = { componente: 'ConfirmationCard', fuente: f.id, salida };
    } else if (esPreparar(cmd.tool)) {
      return cerrar(this.compositor.sobreError(ctxError, 'RESPUESTA_INVALIDA', 'El servidor no devolvió una propuesta válida.', undefined, false), true, 'ErrorNotice');
    } else {
      const pedido = this.orq.opciones.componentesPorTool?.[cmd.tool];
      let fuente = this.store.guardarLectura(cmd.tool, argsLimpios, salida, intentId, dueno.nombre);
      let componente = pedido;
      if (!componente || !(this.hidratadores[componente]?.acepta(fuente) ?? false)) {
        if (componente) t('comando_componente_incompatible', { tool: cmd.tool, componente });
        const vista = vistaPorDefecto(cmd.tool, salida);
        fuente = this.store.guardarLectura(cmd.tool, argsLimpios, vista.salida, intentId, dueno.nombre);
        componente = vista.componente;
      }
      t('tool_ok', { tool: cmd.tool, source_id: fuente.id, componente });
      directiva = { componente, fuente: fuente.id, salida };
    }

    const comp = this.compositor.componer({ tipo: 'render_ui', component: directiva.componente, proposal_id: directiva.fuente }, { ...ctxComp, componentesPermitidos: [directiva.componente] });
    if (!comp.ok) {
      t('validacion_fallida', { errores: comp.errores });
      return cerrar(this.compositor.sobreError(ctxError, 'UI_INVALIDA', 'No pude armar la pantalla para esto.', undefined, true), true, 'ErrorNotice');
    }
    t('directiva_final', { directiva: 'comando', componente: directiva.componente, fuente: comp.fuenteId, valida: true });
    this.ultimaCorrida?.salidas.push({ dominio: dueno.dominio, salida: { sobre: comp.sobre, esError: false, componente: directiva.componente, ...(comp.fuenteId ? { fuenteId: comp.fuenteId } : {}), acciones: comp.acciones } });
    const f = foco(memoria, this.orq.opciones.clavesIgnoradasEnMemoria);
    this.memoria.recordar({ texto: descripcion, dominios: [dueno.dominio], ...(f ? { foco: f } : {}) });
    return [comp.sobre];
  }

  private async ejecutarPlan(ctx: ContextoIntencion, dominios: string[], texto: string, entradaPrimera: string, emitidos: Sobre[]): Promise<void> {
    const { agentes, contextoDelNegocio } = this.orq.opciones;
    const extra = contextoDelNegocio?.(this.contexto);
    for (const [i, dominio] of dominios.entries()) {
      const agente = agentes.get(dominio);
      if (!agente) continue;
      const entrada =
        i === 0
          ? `${entradaPrimera}\n\n[Contexto de la sesión: ${this.memoria.texto()}]`
          : `Pedido completo de la persona: "${texto}". Tu parte es el área ${dominio}. Ya resuelto: ${ctx.memoria.completados.join(', ') || 'nada'}. Datos de la intención: ${ctx.memoria.texto()}.`;
      emitidos.push(this.compositor.sobreStatus(ctx.intentId, ctx.traceId, agente.nombre, 'pensando'));
      const salida = await this.runner.ejecutar(agente, ctx, this.contexto, this.store, this.compositor, entrada, extra);
      this.ultimaCorrida?.salidas.push({ dominio, salida });
      emitidos.push(this.compositor.sobreStatus(ctx.intentId, ctx.traceId, agente.nombre, salida.esError ? 'error' : 'listo'));
      emitidos.push(salida.sobre);
      if (salida.cancelado || salida.esError) break;
      if (salida.opciones) {
        this.pendiente = { tipo: 'aclaracion', ctx, dominio, resto: dominios.slice(i + 1), texto, opciones: salida.opciones };
        break;
      }
      ctx.memoria.completados.push(dominio);
    }
    this.memoria.recordar({ texto, dominios: ctx.memoria.completados, ...(foco(ctx.memoria, this.orq.opciones.clavesIgnoradasEnMemoria) ? { foco: foco(ctx.memoria, this.orq.opciones.clavesIgnoradasEnMemoria)! } : {}) });
  }

  private async alAccionar(m: Obj): Promise<Sobre[]> {
    const intentId = String(m['intent_id']);
    const accion = String(m['action_id']);
    const traceId = this.ultimaCorrida?.intentId === intentId ? this.ultimaCorrida.traceId : nuevoTraceId();
    const proposalId = typeof m['proposal_id'] === 'string' ? m['proposal_id'] : undefined;
    const fuente = proposalId ? this.store.get(proposalId) : undefined;
    const agente = fuente?.agente ?? 'orquestador';

    if (accion === 'confirmar') {
      if (!proposalId) return [this.compositor.sobreToast(this.ctxOrquestador(intentId, traceId), 'error', 'Falta indicar qué confirmar.')];
      const conf = esObjeto(m['confirmation']) ? m['confirmation'] : {};
      const step = esObjeto(conf['step_up']) ? conf['step_up'] : undefined;
      const r = await this.confirmador.confirmar(
        {
          proposalId,
          tokenSuperficie: typeof conf['confirmation_token'] === 'string' ? conf['confirmation_token'] : undefined,
          idempotencyKey: typeof conf['idempotency_key'] === 'string' ? conf['idempotency_key'] : undefined,
          autorizacion: step ? autorizacionDe(step) : undefined,
        },
        this.contexto,
        traceId,
      );
      return this.respuestaDeConfirmacion(r, { intentId, traceId, agente });
    }
    if (accion === 'cancelar') {
      const abandonadas = this.store.abandonarIntencion(intentId);
      this.orq.trace.registrar(traceId, intentId, 'cancelada_por_persona', { propuestas: abandonadas });
      this.pendiente = undefined;
      return [this.compositor.sobreDismiss(intentId, traceId, agente)];
    }
    if (accion === 'cerrar') return [this.compositor.sobreDismiss(intentId, traceId, agente)];
    if (accion === 'elegir' && typeof m['option_id'] === 'string') return this.alElegir(m['option_id'], intentId);
    this.orq.trace.registrar(traceId, intentId, 'accion_desconocida', { accion });
    return [];
  }

  private respuestaDeConfirmacion(r: ResultadoConfirmacion, c: { intentId: string; traceId: string; agente: string }): Sobre[] {
    const ctx = this.ctxOrquestador(c.intentId, c.traceId, c.agente);
    if (r.ok) {
      const total = esObjeto(r.datos['resultado']) ? r.datos['resultado']['total'] : undefined;
      return [this.compositor.sobreDismiss(c.intentId, c.traceId, c.agente, 'ConfirmationCard'), this.compositor.sobreToast(ctx, 'exito', r.mensaje, total)];
    }
    // Sin autorización o con PIN incorrecto la propuesta sigue abierta: es un aviso, no un cierre.
    return [this.compositor.sobreToast(ctx, r.codigo === 'TOKEN_INVALIDO' ? 'error' : 'aviso', r.mensaje)];
  }

  private async alElegir(opcionId: string, intentId: string): Promise<Sobre[]> {
    const p = this.pendiente;
    if (!p) return [];
    const emitidos: Sobre[] = [];
    if (p.tipo === 'dominio') {
      if (!this.orq.opciones.agentes.get(opcionId)) return [];
      this.pendiente = undefined;
      this.ultimaCorrida = { intentId: p.ctx.intentId, traceId: p.ctx.traceId, texto: p.texto, plan: { plan: [opcionId], origen: 'sin_clasificar', entidades: {} }, salidas: [] };
      await this.ejecutarPlan(p.ctx, [opcionId], p.texto, p.texto, emitidos);
      return emitidos;
    }
    const opcion = p.opciones.find((o) => o.id === opcionId);
    if (!opcion || p.ctx.intentId !== intentId) return [];
    this.pendiente = undefined;
    this.orq.trace.registrar(p.ctx.traceId, p.ctx.intentId, 'aclaracion_resuelta', { opcion: opcionId });
    await this.ejecutarPlan(p.ctx, [p.dominio, ...p.resto], p.texto, `La persona eligió la opción ${opcion.id} (${opcion.etiqueta}). Seguí con el pedido original.`, emitidos);
    return emitidos;
  }

  private alDescartar(intentId: string, porPersona: boolean): Sobre[] {
    if (porPersona && this.intencionActual?.intentId === intentId) this.intencionActual.control.abort();
    const abandonadas = this.store.abandonarIntencion(intentId);
    this.orq.trace.registrar('tr_descarte', intentId, 'ui_descartada', { por_persona: porPersona, propuestas: abandonadas });
    return [];
  }

  private ctxOrquestador(intentId: string, traceId: string, agente = 'orquestador'): ContextoComposicion {
    return { intentId, traceId, agente, componentesPermitidos: [] };
  }
}

/** Lo que mandó la pantalla en `confirmation.step_up`: usuario y PIN de quien autoriza y/o el motivo. */
const autorizacionDe = (step: Obj): Autorizacion => ({
  ...(typeof step['usuario'] === 'string' ? { usuario: step['usuario'] } : {}),
  ...(typeof step['pin'] === 'string' ? { pin: step['pin'] } : {}),
  ...(typeof step['motivo'] === 'string' ? { motivo: step['motivo'] } : {}),
});

/** Primera entidad de la memoria que no sea una clave ignorada (ver `clavesIgnoradasEnMemoria`). */
export const foco = (m: MemoriaIntencion, ignoradas: readonly string[] = CLAVES_IGNORADAS_EN_MEMORIA): { tipo: string; id: string } | undefined => {
  const e = [...m.entidades].filter(([k]) => !ignoradas.includes(k))[0];
  return e ? { tipo: e[0].replace(/_id$/, ''), id: e[1] } : undefined;
};
