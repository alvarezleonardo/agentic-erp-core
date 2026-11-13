import type { Directiva, DirectivaClarify, DirectivaRender } from './directivas.js';
import type { ContractValidator } from './ContractValidator.js';
import { buscarPorId, HIDRATADORES_BASE, type AccionCatalogo, type Hidratador } from './hidratacion.js';
import type { Fuente, ProposalStore } from './ProposalStore.js';
import { clonar, contieneMonto, esObjeto, nuevoMessageId, type Obj } from './util.js';

export type Sobre = Obj;
export type { AccionCatalogo } from './hidratacion.js';

/** Acciones por componente. `confirms` lo decide SIEMPRE este catálogo (o el hidratador), nunca el modelo. */
export const ACCIONES_BASE: Readonly<Record<string, readonly AccionCatalogo[]>> = {
  ConfirmationCard: [
    { id: 'confirmar', label: 'Confirmar', kind: 'primary', confirms: true },
    { id: 'cancelar', label: 'Cancelar', kind: 'ghost' },
  ],
  Clarification: [
    { id: 'elegir', label: 'Elegir', kind: 'primary' },
    { id: 'cancelar', label: 'Cancelar', kind: 'ghost' },
  ],
  FormCard: [
    { id: 'enviar', label: 'Continuar', kind: 'primary' },
    { id: 'cancelar', label: 'Cancelar', kind: 'ghost' },
  ],
  DataTable: [{ id: 'cerrar', label: 'Cerrar', kind: 'ghost' }],
  KpiTiles: [{ id: 'cerrar', label: 'Cerrar', kind: 'ghost' }],
  DetailCard: [{ id: 'cerrar', label: 'Cerrar', kind: 'ghost' }],
  TrendChart: [{ id: 'cerrar', label: 'Cerrar', kind: 'ghost' }],
  ErrorNotice: [{ id: 'cerrar', label: 'Entendido', kind: 'ghost' }],
};

/** Ciclo de vida por componente: lo de confirmación se queda hasta confirmar o cancelar; los avisos se van por tiempo. */
const LIFECYCLE: Readonly<Record<string, Obj>> = {
  ConfirmationCard: { dismiss_on: ['action_done', 'new_intent'] },
  Clarification: { dismiss_on: ['action_done', 'new_intent'] },
  FormCard: { dismiss_on: ['action_done', 'new_intent'] },
  DataTable: { dismiss_on: ['new_intent'] },
  KpiTiles: { dismiss_on: ['new_intent'] },
  DetailCard: { dismiss_on: ['new_intent'] },
  TrendChart: { dismiss_on: ['new_intent'] },
  ErrorNotice: { dismiss_on: ['new_intent', 'timeout'], ttl_ms: 15_000 },
  StatusToast: { dismiss_on: ['timeout'], ttl_ms: 4_000 },
};

export interface ContextoComposicion {
  intentId: string;
  traceId: string;
  agente: string;
  componentesPermitidos: readonly string[];
}

export interface Descarte {
  campo: string;
  motivo: 'x-source' | 'proveniente_de_fuente' | 'campo_desconocido' | 'accion_fuera_de_catalogo' | 'speech_con_monto';
}

export type ResultadoComposicion =
  | {
      ok: true;
      sobre: Sobre;
      descartes: Descarte[];
      /** Id de la fuente (propuesta o lectura) de la que se hidrató, si hubo. */
      fuenteId?: string;
      acciones: AccionCatalogo[];
      opciones?: { id: string; etiqueta: string }[];
    }
  | { ok: false; errores: string[] };

const tieneXSource = (schema: unknown): boolean => {
  if (Array.isArray(schema)) return schema.some(tieneXSource);
  if (!esObjeto(schema)) return false;
  if ('x-source' in schema) return true;
  return Object.values(schema).some(tieneXSource);
};

/** Conserva de `valor` solo lo que declara el schema cuando el schema es cerrado. */
function podar(valor: unknown, schema: unknown): unknown {
  if (!esObjeto(schema) || '$ref' in schema) return valor;
  if (Array.isArray(valor)) return valor.map((v) => podar(v, schema['items']));
  if (esObjeto(valor) && esObjeto(schema['properties'])) {
    const props = schema['properties'];
    const out: Obj = {};
    for (const [k, v] of Object.entries(valor)) {
      if (k in props) out[k] = podar(v, props[k]);
      else if (schema['additionalProperties'] !== false) out[k] = v;
    }
    return out;
  }
  return valor;
}

const NIVELES = ['info', 'exito', 'aviso', 'error'] as const;
const recortar = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const esDinero = (v: unknown): boolean => esObjeto(v) && typeof v['monto'] === 'string' && typeof v['moneda'] === 'string';

/**
 * Convierte la directiva final del modelo en un sobre validado. Es la pieza que hace cumplir el principio
 * «los montos los pone el servidor»: lo que el modelo escriba en `data` y esté marcado `x-source` en el
 * schema se descarta, y el valor sale de la salida del tool.
 */
export class Compositor {
  /** Componentes y versiones que declaró la superficie en client.hello (undefined = no declaró). */
  soportados: Record<string, number[]> | undefined;

  constructor(
    readonly sessionId: string,
    private readonly validator: ContractValidator,
    private readonly store: ProposalStore,
    private readonly reloj: () => Date = () => new Date(),
    private readonly hidratadores: Readonly<Record<string, Hidratador>> = HIDRATADORES_BASE,
  ) {}

  private base(type: string, intentId: string, traceId: string, agente: string): Sobre {
    return { v: '1.0', type, message_id: nuevoMessageId(), session_id: this.sessionId, intent_id: intentId, meta: { trace_id: traceId, agent: agente } };
  }

  private version(componente: string): number | undefined {
    const disponibles = this.validator.versiones(componente);
    if (!this.soportados) return disponibles[0];
    const comun = disponibles.find((v) => (this.soportados?.[componente] ?? []).includes(v));
    // Un aviso o un error siempre se manda: si la superficie no lo soporta, muestra el genérico.
    if (comun === undefined && (componente === 'ErrorNotice' || componente === 'StatusToast')) return disponibles[0];
    return comun;
  }

  private armar(tipo: 'ui.render' | 'ui.update' | 'ui.toast', componente: string, data: Obj, acciones: AccionCatalogo[], ctx: ContextoComposicion, speech?: string): Sobre | string {
    const version = this.version(componente);
    if (version === undefined) return `la superficie no soporta ${componente}`;
    const sobre = this.base(tipo, ctx.intentId, ctx.traceId, ctx.agente);
    sobre['slot'] = tipo === 'ui.toast' ? 'toast' : 'main';
    sobre['component'] = componente;
    sobre['component_version'] = version;
    sobre['data'] = data;
    if (acciones.length) {
      sobre['actions'] = acciones.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        ...(a.confirms ? { confirms: true } : {}),
        ...(a.step_up && a.step_up !== 'none' ? { step_up: a.step_up } : {}),
      }));
    }
    if (speech) sobre['speech'] = speech;
    sobre['lifecycle'] = clonar(LIFECYCLE[componente] ?? LIFECYCLE['ErrorNotice']);
    return sobre;
  }

  /** Convierte la directiva final del agente en un sobre validado, hidratando desde la fuente. */
  componer(directiva: Directiva, ctx: ContextoComposicion, tipo: 'ui.render' | 'ui.update' = 'ui.render'): ResultadoComposicion {
    if (directiva.tipo === 'report_error') return this.componerError(directiva.codigo, directiva.mensaje, directiva.accion_sugerida, ctx);
    if (directiva.tipo === 'clarify') return this.componerClarify(directiva, ctx);
    return this.componerRender(directiva, ctx, tipo);
  }

  private componerError(codigo: string, mensaje: string, accion: string | undefined, ctx: ContextoComposicion): ResultadoComposicion {
    if (contieneMonto(mensaje) || (accion && contieneMonto(accion))) {
      return { ok: false, errores: ['El mensaje de error no puede llevar importes: describilo sin cifras'] };
    }
    const data: Obj = { codigo, mensaje: recortar(mensaje, 200), ...(accion ? { accion_sugerida: recortar(accion, 200) } : {}) };
    return this.finalizar('ui.render', 'ErrorNotice', data, [...(ACCIONES_BASE['ErrorNotice'] ?? [])], ctx, undefined, [], undefined);
  }

  private componerClarify(d: DirectivaClarify, ctx: ContextoComposicion): ResultadoComposicion {
    if (!ctx.componentesPermitidos.includes('Clarification')) return { ok: false, errores: ['Este agente no puede emitir Clarification'] };
    if (contieneMonto(d.pregunta)) return { ok: false, errores: ['La pregunta no puede llevar importes'] };
    if (new Set(d.opciones.map((o) => o.id)).size < 2) {
      return { ok: false, errores: ['Una Clarification necesita al menos 2 opciones. Con una sola candidata usala directamente y seguí; sin candidatas terminá con report_error.'] };
    }
    const fuentes = this.store.deIntencion(ctx.intentId);
    const opciones: { id: string; etiqueta: string }[] = [];
    const invalidas: string[] = [];
    for (const o of d.opciones) {
      if (opciones.some((x) => x.id === o.id)) continue;
      let hallada: Obj | undefined;
      for (const f of fuentes) {
        hallada = buscarPorId(f.salida, o.id);
        if (hallada) break;
      }
      if (!hallada) {
        invalidas.push(o.id);
        continue;
      }
      // La etiqueta sale del registro del servidor; la del modelo es solo el último recurso.
      const etiqueta = [hallada['nombre'], hallada['etiqueta']].find((x): x is string => typeof x === 'string') ?? o.etiqueta ?? o.id;
      opciones.push({ id: o.id, etiqueta: recortar(etiqueta, 80) });
    }
    if (invalidas.length) {
      return { ok: false, errores: [`Las opciones ${invalidas.join(', ')} no salen de ningún resultado de tool de esta intención; usá ids reales devueltos por un tool`] };
    }
    return this.finalizar('ui.render', 'Clarification', { pregunta: d.pregunta, opciones }, [...(ACCIONES_BASE['Clarification'] ?? [])], ctx, undefined, [], undefined, opciones);
  }

  /** Última fuente abierta de esta intención que el hidratador acepta (cuando el modelo no pasó, o pasó mal, el proposal_id). */
  private fuenteAlternativa(ctx: ContextoComposicion, acepta: (f: Fuente) => boolean): Fuente | undefined {
    return [...this.store.deIntencion(ctx.intentId)].reverse().find((f) => f.estado === 'abierta' && acepta(f));
  }

  private componerRender(d: DirectivaRender, ctx: ContextoComposicion, tipo: 'ui.render' | 'ui.update'): ResultadoComposicion {
    const nombre = d.component;
    if (!ctx.componentesPermitidos.includes(nombre)) {
      return { ok: false, errores: [`El componente ${nombre} no está permitido para este agente; permitidos: ${ctx.componentesPermitidos.join(', ')}`] };
    }
    if (nombre === 'Clarification') return { ok: false, errores: ['Para Clarification usá la función clarify'] };
    const version = this.version(nombre);
    if (version === undefined) return { ok: false, errores: [`La superficie no soporta ${nombre}`] };
    const info = this.validator.componente(nombre, version);
    if (!info) return { ok: false, errores: [`Componente desconocido: ${nombre}`] };
    const props = esObjeto(info.schema['properties']) ? info.schema['properties'] : {};

    const descartes: Descarte[] = [];
    const hid = this.hidratadores[nombre];
    let fuente: Fuente | undefined;
    let hidratado: Obj = {};
    let accionesFuente: AccionCatalogo[] | undefined;
    if (hid) {
      const pedida = d.proposal_id ? this.store.get(d.proposal_id) : undefined;
      if (pedida && pedida.intentId === ctx.intentId && hid.acepta(pedida)) {
        fuente = pedida;
      } else {
        // Sin proposal_id, o uno de otra intención o de otro tipo: se toma la última fuente válida de la intención.
        fuente = this.fuenteAlternativa(ctx, hid.acepta);
        if (!fuente) {
          if (!d.proposal_id) return { ok: false, errores: [`${nombre} se hidrata desde ${hid.esperada}: pasá su proposal_id (o source_id)`] };
          if (!pedida || pedida.intentId !== ctx.intentId) return { ok: false, errores: [`La fuente ${d.proposal_id} no existe en esta intención`] };
          return { ok: false, errores: [`La fuente ${d.proposal_id} (${pedida.tool}) no sirve: ${nombre} requiere ${hid.esperada}`] };
        }
        if (d.proposal_id) descartes.push({ campo: 'proposal_id', motivo: 'campo_desconocido' });
      }
      if (fuente.estado !== 'abierta') return { ok: false, errores: [`La propuesta ${fuente.id} ya no está vigente (${fuente.estado}); volvé a preparar la operación`] };
      const h = hid.hidratar(fuente, { ahora: this.reloj });
      if (h.error) return { ok: false, errores: [h.error] };
      hidratado = podar(h.fuente, info.schema) as Obj;
      accionesFuente = h.acciones;
    } else if (d.proposal_id) {
      descartes.push({ campo: 'proposal_id', motivo: 'campo_desconocido' });
    }

    // Lo que escribió el modelo: solo se acepta lo que no es x-source ni viene de la fuente.
    const data: Obj = { ...hidratado };
    for (const [k, v] of Object.entries(d.data ?? {})) {
      if (!(k in props)) descartes.push({ campo: k, motivo: 'campo_desconocido' });
      else if (tieneXSource(props[k])) descartes.push({ campo: k, motivo: 'x-source' });
      else if (k in hidratado) descartes.push({ campo: k, motivo: 'proveniente_de_fuente' });
      else data[k] = v;
    }

    // Texto libre del modelo en componentes sin fuente: nunca cifras.
    for (const campo of ['mensaje', 'accion_sugerida', 'titulo', 'descripcion']) {
      const v = data[campo];
      if (!(campo in hidratado) && typeof v === 'string' && contieneMonto(v)) return { ok: false, errores: [`${campo} no puede llevar importes: los montos viajan en data desde el servidor`] };
    }

    let speech = d.speech;
    if (speech && (contieneMonto(speech) || speech.length > 280)) {
      descartes.push({ campo: 'speech', motivo: 'speech_con_monto' });
      speech = undefined;
    }

    // Componentes informativos sin fuente: completar defaults válidos en vez de fallar.
    if (nombre === 'StatusToast') {
      if (!NIVELES.includes(data['nivel'] as (typeof NIVELES)[number])) data['nivel'] = 'info';
      if (typeof data['mensaje'] !== 'string' || !data['mensaje'].trim()) data['mensaje'] = speech && speech.trim() ? speech : 'Listo.';
      data['mensaje'] = recortar(data['mensaje'] as string, 140);
    } else if (nombre === 'ErrorNotice') {
      if (typeof data['codigo'] !== 'string' || !/^[A-Za-z][A-Za-z_]{1,48}$/.test(data['codigo'])) data['codigo'] = 'AGENTE_SIN_RESOLUCION';
      if (typeof data['mensaje'] !== 'string' || !data['mensaje'].trim()) data['mensaje'] = speech && speech.trim() ? speech : 'No pude resolver el pedido. Probá de nuevo o reformulalo.';
      data['mensaje'] = recortar(data['mensaje'] as string, 200);
    }

    // Acciones: el catálogo decide; el modelo solo puede elegir un subconjunto y rotular.
    const catalogo = accionesFuente ? [...accionesFuente] : [...(ACCIONES_BASE[nombre] ?? [])];
    let acciones = catalogo;
    if (d.actions?.length) {
      const elegidas: AccionCatalogo[] = [];
      for (const a of d.actions) {
        const base = catalogo.find((c) => c.id === a.id);
        if (!base) {
          descartes.push({ campo: `actions.${a.id}`, motivo: 'accion_fuera_de_catalogo' });
          continue;
        }
        elegidas.push({ ...base, label: a.label && a.label.length <= 32 && !contieneMonto(a.label) ? a.label : base.label });
      }
      if (elegidas.length) acciones = elegidas;
    }
    return this.finalizar(nombre === 'StatusToast' ? 'ui.toast' : tipo, nombre, data, acciones, ctx, speech, descartes, fuente?.id);
  }

  private finalizar(
    tipo: 'ui.render' | 'ui.update' | 'ui.toast',
    nombre: string,
    data: Obj,
    acciones: AccionCatalogo[],
    ctx: ContextoComposicion,
    speech: string | undefined,
    descartes: Descarte[],
    fuenteId: string | undefined,
    opciones?: { id: string; etiqueta: string }[],
  ): ResultadoComposicion {
    const sobre = this.armar(tipo, nombre, data, acciones, ctx, speech);
    if (typeof sobre === 'string') return { ok: false, errores: [sobre] };
    const v = this.validator.validarSobre(sobre);
    if (!v.ok) return { ok: false, errores: v.errores };
    return { ok: true, sobre, descartes, ...(fuenteId ? { fuenteId } : {}), acciones, ...(opciones ? { opciones } : {}) };
  }

  // ---- Sobres que arma el orquestador sin pasar por el modelo ----

  /** ErrorNotice a partir de datos propios; si el código no cumple el schema se usa uno genérico. */
  sobreError(ctx: ContextoComposicion, codigo: string, mensaje: string, accion?: string, reintentable?: boolean): Sobre {
    const intentos: Obj[] = [
      { codigo, mensaje: recortar(mensaje, 200), ...(accion ? { accion_sugerida: recortar(accion, 200) } : {}), ...(reintentable !== undefined ? { reintentable } : {}) },
      { codigo: 'ERROR_AGENTE', mensaje: 'No pude completar la operación. Probá de nuevo o reformulá el pedido.' },
    ];
    for (const data of intentos) {
      const s = this.armar('ui.render', 'ErrorNotice', data, [...(ACCIONES_BASE['ErrorNotice'] ?? [])], ctx);
      if (typeof s !== 'string' && this.validator.validarSobre(s).ok) return s;
    }
    throw new Error('No se pudo armar un ErrorNotice válido');
  }

  /** Clarification con opciones fijas del orquestador (router sin clasificar); no sale de un tool. */
  sobreClarificacionFija(ctx: ContextoComposicion, pregunta: string, opciones: { id: string; etiqueta: string }[]): Sobre {
    const s = this.armar('ui.render', 'Clarification', { pregunta, opciones }, [...(ACCIONES_BASE['Clarification'] ?? [])], ctx);
    if (typeof s === 'string' || !this.validator.validarSobre(s).ok) throw new Error('Clarification inválida');
    return s;
  }

  sobreToast(ctx: ContextoComposicion, nivel: 'info' | 'exito' | 'aviso' | 'error', mensaje: string, monto?: unknown, titulo?: string): Sobre {
    const data: Obj = { nivel, mensaje: recortar(mensaje, 140), ...(titulo ? { titulo: titulo.slice(0, 60) } : {}), ...(esDinero(monto) ? { monto } : {}) };
    const s = this.armar('ui.toast', 'StatusToast', data, [], ctx);
    if (typeof s === 'string' || !this.validator.validarSobre(s).ok) throw new Error(`StatusToast inválido: ${typeof s === 'string' ? s : this.validator.validarSobre(s).errores.join('; ')}`);
    return s;
  }

  /** Retira una tarjeta (con `componente`) o cierra la intención entera. */
  sobreDismiss(intentId: string, traceId: string, agente: string, componente?: string): Sobre {
    const s = this.base('ui.dismiss', intentId, traceId, agente);
    if (componente) s['component'] = componente;
    return s;
  }

  sobreStatus(intentId: string, traceId: string, agente: string, status: 'pensando' | 'ejecutando' | 'listo' | 'error'): Sobre {
    const s = this.base('agent.status', intentId, traceId, agente);
    s['status'] = status;
    return s;
  }
}
