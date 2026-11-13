import { MAX_MOTIVO, claveIdempotencia, confirmarDe, faltanteDeStepUp, pideMotivo, pideSupervisor, stepUpDe, type Autorizacion, type ContextoSesion, type StepUp } from '@agentic-erp/mcp-contract';
import type { Herramientas } from './Herramientas.js';
import type { Fuente, ProposalStore } from './ProposalStore.js';
import type { Trace } from './trace.js';
import type { Obj } from './util.js';

/** Lo que manda la superficie al tocar «Confirmar». El token viaja por acá, nunca por el modelo. */
export interface SolicitudConfirmacion {
  proposalId: string;
  tokenSuperficie?: string | undefined;
  /** Si la superficie no manda una, se deriva del proposal_id: un doble toque nunca ejecuta dos veces. */
  idempotencyKey?: string | undefined;
  /**
   * Lo que pidió el step-up de la propuesta: usuario y PIN de quien autoriza y/o el motivo. Pasan al servidor,
   * que es quien los verifica; el PIN nunca llega al modelo ni a las trazas.
   */
  autorizacion?: Autorizacion | undefined;
}

export type ResultadoConfirmacion =
  | { ok: true; idempotente: boolean; datos: Obj; mensaje: string }
  | { ok: false; codigo: string; mensaje: string; accion_sugerida?: string };

export interface OpcionesConfirmador {
  reloj?: () => Date;
  /** Política adicional de step-up del despliegue (además de lo que declara la propuesta); si devuelve true se exige `supervisor` como mínimo. */
  requiereStepUp?: (fuente: Fuente) => boolean;
}

const falla = (codigo: string, mensaje: string, accion_sugerida?: string): ResultadoConfirmacion => ({ ok: false, codigo, mensaje, ...(accion_sugerida ? { accion_sugerida } : {}) });

/**
 * El único camino por el que una propuesta se convierte en un cambio real. Verifica propuesta vigente, token
 * (en tiempo constante), step-up y expiración; llama `confirmar_*` con el token guardado y una clave de
 * idempotencia; y registra el resultado para que repetir la confirmación devuelva lo mismo sin repetir el efecto.
 */
export class Confirmador {
  constructor(
    private readonly store: ProposalStore,
    private readonly herramientas: Herramientas,
    private readonly trace: Trace,
    private readonly o: OpcionesConfirmador = {},
  ) {}

  async confirmar(sol: SolicitudConfirmacion, contexto: ContextoSesion, traceId: string): Promise<ResultadoConfirmacion> {
    const ahora = (this.o.reloj ?? (() => new Date()))();
    const f = this.store.get(sol.proposalId);
    const t = (evento: string, datos: Record<string, unknown> = {}): void => this.trace.registrar(traceId, f?.intentId ?? 'sin_intencion', evento, { proposal_id: sol.proposalId, ...datos });

    if (!f || f.kind !== 'proposal') {
      t('confirmacion_rechazada', { codigo: 'PROPUESTA_NO_ENCONTRADA' });
      return falla('PROPUESTA_NO_ENCONTRADA', 'No encuentro esa propuesta.', 'Pedí la operación de nuevo.');
    }
    if (!this.store.tokenCoincide(f.id, sol.tokenSuperficie)) {
      t('confirmacion_rechazada', { codigo: 'TOKEN_INVALIDO' });
      return falla('TOKEN_INVALIDO', 'La confirmación no es válida.', 'Pedí la operación de nuevo.');
    }
    const clave = sol.idempotencyKey ?? claveIdempotencia(contexto, f.id);

    if (f.estado === 'confirmada') {
      if (f.confirmadaCon?.idempotencyKey === clave) {
        t('confirmacion_idempotente');
        return { ok: true, idempotente: true, datos: { ...f.confirmadaCon.resultado, idempotente: true }, mensaje: textoDe(f.confirmadaCon.resultado) };
      }
      t('confirmacion_rechazada', { codigo: 'PROPUESTA_YA_CONFIRMADA' });
      return falla('PROPUESTA_YA_CONFIRMADA', 'Esta propuesta ya se confirmó.');
    }
    if (f.estado !== 'abierta') {
      t('confirmacion_rechazada', { codigo: 'PROPUESTA_NO_VIGENTE', estado: f.estado });
      return falla('PROPUESTA_NO_VIGENTE', 'Esa propuesta ya no está vigente.', 'Pedí la operación de nuevo.');
    }
    const expira = typeof f.salida['expira_en'] === 'string' ? Date.parse(f.salida['expira_en']) : NaN;
    if (Number.isFinite(expira) && expira <= ahora.getTime()) {
      this.store.marcar(f.id, 'abandonada');
      t('confirmacion_rechazada', { codigo: 'PROPUESTA_EXPIRADA' });
      return falla('PROPUESTA_EXPIRADA', 'La propuesta venció.', 'Pedí la operación de nuevo.');
    }
    const nivel = nivelExigido(f, this.o.requiereStepUp);
    const faltante = faltanteDeStepUp(nivel, sol.autorizacion);
    if (faltante) {
      // No se consume nada: la propuesta sigue abierta y la superficie pide lo que falta (PIN y/o motivo).
      t('confirmacion_rechazada', { codigo: 'STEP_UP_REQUERIDO', step_up: nivel });
      return falla('STEP_UP_REQUERIDO', faltante.mensaje, faltante.accion_sugerida);
    }
    if (pideMotivo(nivel) && (sol.autorizacion?.motivo?.trim().length ?? 0) > MAX_MOTIVO) {
      t('confirmacion_rechazada', { codigo: 'PARAMETRO_INVALIDO', step_up: nivel });
      return falla('PARAMETRO_INVALIDO', `El motivo no puede pasar de ${MAX_MOTIVO} caracteres.`, 'Escribí un motivo más corto.');
    }
    const autorizacion = depurarAutorizacion(nivel, sol.autorizacion);

    const token = this.store.tokenDe(f.id);
    if (!token) return falla('PROPUESTA_NO_VIGENTE', 'Esa propuesta ya no está vigente.');
    // El PIN no se registra ni como valor (redactar() lo taparía igual); el motivo sí puede quedar en la traza.
    t('confirmacion_enviada', { tool: confirmarDe(f.tool), step_up: nivel, con_autorizacion: Boolean(autorizacion?.pin), ...(autorizacion?.motivo ? { motivo: autorizacion.motivo } : {}) });
    const r = await this.herramientas.confirmar(
      confirmarDe(f.tool),
      { proposal_id: f.id, confirmation_token: token, idempotency_key: clave, ...(autorizacion ? { autorizacion } : {}) },
      contexto,
    );
    if (!r.ok) {
      const codigo = typeof r.datos['codigo'] === 'string' ? r.datos['codigo'] : 'CONFIRMACION_FALLIDA';
      // Un rechazo definitivo del servidor cierra la propuesta; uno corregible (PIN mal) la deja abierta.
      if (['PROPUESTA_EXPIRADA', 'PROPUESTA_YA_CONFIRMADA', 'PROPUESTA_NO_ENCONTRADA'].includes(codigo)) this.store.marcar(f.id, 'abandonada');
      t('confirmacion_rechazada', { codigo, origen: 'servidor' });
      const accion = typeof r.datos['accion_sugerida'] === 'string' ? r.datos['accion_sugerida'] : undefined;
      return falla(codigo, typeof r.datos['mensaje'] === 'string' ? r.datos['mensaje'] : 'No se pudo confirmar.', accion);
    }
    this.store.registrarConfirmacion(f.id, clave, r.datos);
    t('confirmacion_aplicada', { tool: confirmarDe(f.tool), idempotente: r.datos['idempotente'] === true });
    return { ok: true, idempotente: r.datos['idempotente'] === true, datos: r.datos, mensaje: textoDe(r.datos) };
  }
}

/** Nivel de step-up que se exige: el que declara la propuesta o, como mínimo, `supervisor` si la política del despliegue lo pide. */
function nivelExigido(f: Fuente, politica: ((f: Fuente) => boolean) | undefined): StepUp {
  const declarado = stepUpDe(f.salida);
  return !pideSupervisor(declarado) && (politica?.(f) ?? false) ? (pideMotivo(declarado) ? 'supervisor_y_motivo' : 'supervisor') : declarado;
}

/** Solo viaja al servidor lo que el nivel pide: si no se pide supervisor, un PIN que la pantalla haya mandado de más no sale de acá. */
function depurarAutorizacion(nivel: StepUp, a: Autorizacion | undefined): Autorizacion | undefined {
  if (!a) return undefined;
  const out: Autorizacion = {};
  if (pideSupervisor(nivel) && a.usuario && a.pin) {
    out.usuario = a.usuario;
    out.pin = a.pin;
  }
  const motivo = a.motivo?.trim();
  if (pideMotivo(nivel) && motivo) out.motivo = motivo;
  return Object.keys(out).length ? out : undefined;
}

const textoDe = (datos: Obj): string => (typeof datos['mensaje'] === 'string' && datos['mensaje'] ? datos['mensaje'] : 'Listo, quedó confirmado.');
