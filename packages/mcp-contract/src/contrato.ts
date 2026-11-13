import type { Autorizacion, Obj, Propuesta, StepUp } from './tipos.js';

/** Campos que el orquestador inyecta en cada tool y el modelo nunca ve ni fija. */
export const CAMPOS_RESERVADOS = ['contexto', 'idempotency_key', 'id_intencion'] as const;

/** Capacidades opcionales (opt-in) que un servidor puede declarar. */
export const CAPACIDADES = ['metricas', 'eventos'] as const;
export type Capacidad = (typeof CAPACIDADES)[number];

/** Tools que exige cada capacidad declarada. */
export const TOOLS_POR_CAPACIDAD: Record<Capacidad, readonly string[]> = {
  metricas: ['listar_metricas', 'consultar_metrica'],
  eventos: ['consumir_eventos'],
};

/** Tools exigidas cuando el servidor no declara capacidades (todas): se conserva por compatibilidad. */
export const TOOLS_OBLIGATORIAS = CAPACIDADES.flatMap((c) => TOOLS_POR_CAPACIDAD[c]);

/** Tools opcionales con forma definida por el contrato. */
export const TOOLS_OPCIONALES = ['serie_metrica', 'detectar_anomalias'] as const;

/** Códigos de error con significado fijo para el orquestador. */
export const CODIGOS_ERROR_CONTRATO = [
  'PERMISO_DENEGADO',
  'PROPUESTA_NO_ENCONTRADA',
  'PROPUESTA_EXPIRADA',
  'PROPUESTA_YA_CONFIRMADA',
  'TOKEN_INVALIDO',
  'STEP_UP_REQUERIDO',
  'AUTORIZACION_INVALIDA',
  'PARAMETRO_INVALIDO',
  'NO_ENCONTRADO',
] as const;
export type CodigoErrorContrato = (typeof CODIGOS_ERROR_CONTRATO)[number];

const PREFIJOS_LECTURA = ['listar_', 'obtener_', 'consultar_', 'resumen_', 'ranking_', 'serie_', 'detectar_', 'sugerir_', 'consumir_'] as const;

export const esPreparar = (nombre: string): boolean => nombre.startsWith('preparar_');
export const esConfirmar = (nombre: string): boolean => nombre.startsWith('confirmar_');
export const esLectura = (nombre: string): boolean => PREFIJOS_LECTURA.some((p) => nombre.startsWith(p));

/** `preparar_orden_compra` -> `confirmar_orden_compra`. */
export const confirmarDe = (preparar: string): string => `confirmar_${preparar.slice('preparar_'.length)}`;
export const prepararDe = (confirmar: string): string => `preparar_${confirmar.slice('confirmar_'.length)}`;

/** Quita los campos reservados de un esquema de entrada para mostrárselo al modelo. */
export function esquemaParaModelo(esquema: Obj): Obj {
  const copia = structuredClone(esquema);
  const props = copia['properties'];
  if (typeof props === 'object' && props !== null) for (const c of CAMPOS_RESERVADOS) delete (props as Obj)[c];
  if (Array.isArray(copia['required'])) copia['required'] = (copia['required'] as string[]).filter((r) => !(CAMPOS_RESERVADOS as readonly string[]).includes(r));
  return copia;
}

// ---------- Step-up ----------

/** Niveles de step-up, de menor a mayor exigencia. */
export const NIVELES_STEP_UP: readonly StepUp[] = ['none', 'motivo', 'supervisor', 'supervisor_y_motivo'];

/** Largo máximo del motivo que acepta el contrato. */
export const MAX_MOTIVO = 200;

/**
 * Normaliza un nivel de step-up. `autorizacion` es el nombre anterior de `supervisor` y se sigue aceptando;
 * `true` y `false` son el viejo `requiere_step_up`. Lo que no se reconoce devuelve `undefined`.
 */
export function normalizarStepUp(valor: unknown): StepUp | undefined {
  if (valor === true || valor === 'autorizacion') return 'supervisor';
  if (valor === false) return 'none';
  return NIVELES_STEP_UP.find((n) => n === valor);
}

/** Step-up efectivo de una propuesta: `step_up` si lo declara; si no, `requiere_step_up` (true = supervisor). */
export function stepUpDe(propuesta: Pick<Propuesta, 'step_up' | 'requiere_step_up'> | Obj): StepUp {
  return normalizarStepUp(propuesta['step_up']) ?? normalizarStepUp(propuesta['requiere_step_up']) ?? 'none';
}

/** ¿El nivel pide usuario y PIN de un supervisor? */
export const pideSupervisor = (s: StepUp): boolean => s === 'supervisor' || s === 'supervisor_y_motivo';

/** ¿El nivel pide un motivo escrito? */
export const pideMotivo = (s: StepUp): boolean => s === 'motivo' || s === 'supervisor_y_motivo';

export interface FaltanteStepUp {
  /** Qué falta, en lenguaje para la persona. */
  mensaje: string;
  accion_sugerida: string;
}

/**
 * Qué le falta a una autorización para cumplir el nivel pedido (undefined si está completa). Solo mira presencia y
 * forma: quién puede autorizar y si el PIN es correcto lo decide el servidor.
 */
export function faltanteDeStepUp(nivel: StepUp, autorizacion: Autorizacion | undefined): FaltanteStepUp | undefined {
  const sinSupervisor = pideSupervisor(nivel) && !(autorizacion?.usuario?.trim() && autorizacion.pin);
  const sinMotivo = pideMotivo(nivel) && !autorizacion?.motivo?.trim();
  if (sinSupervisor && sinMotivo) return { mensaje: 'Esta operación necesita la autorización de un responsable y un motivo.', accion_sugerida: 'Ingresá usuario y PIN de quien autoriza y escribí el motivo.' };
  if (sinSupervisor) return { mensaje: 'Esta operación necesita la autorización de un responsable.', accion_sugerida: 'Ingresá usuario y PIN de quien autoriza.' };
  if (sinMotivo) return { mensaje: 'Esta operación necesita que indiques el motivo.', accion_sugerida: 'Escribí el motivo.' };
  return undefined;
}
