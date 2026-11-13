import { CAMPOS_RESERVADOS, CAPACIDADES, TOOLS_POR_CAPACIDAD, type Capacidad, confirmarDe, esConfirmar, esLectura, esPreparar, prepararDe } from './contrato.js';
import { esObjeto, type Obj, type ToolMcp } from './tipos.js';

export interface Hallazgo {
  nivel: 'error' | 'aviso';
  tool?: string;
  mensaje: string;
}

export interface OpcionesConformidad {
  /**
   * Capacidades que declara el servidor (`'metricas'`, `'eventos'`). Solo se exigen las tools de las capacidades
   * declaradas. Si se omite, se asume el comportamiento previo: todas las capacidades.
   */
  capacidades?: readonly Capacidad[];
}

export interface InformeConformidad {
  ok: boolean;
  hallazgos: Hallazgo[];
}

const propiedades = (t: ToolMcp): Obj => (esObjeto(t.esquema['properties']) ? t.esquema['properties'] : {});
const requeridos = (t: ToolMcp): string[] => (Array.isArray(t.esquema['required']) ? (t.esquema['required'] as string[]) : []);

/**
 * Verifica que el catálogo de tools de un servidor MCP cumpla el contrato:
 * tools de las capacidades declaradas, `contexto` requerido en todos, pares preparar/confirmar completos
 * y con la forma de entrada que exige la confirmación (token, idempotencia).
 * No ejecuta nada: mira solo los esquemas publicados.
 */
export function verificarConformidad(tools: readonly ToolMcp[], opciones: OpcionesConformidad = {}): InformeConformidad {
  const hallazgos: Hallazgo[] = [];
  const error = (mensaje: string, tool?: string): void => void hallazgos.push({ nivel: 'error', mensaje, ...(tool ? { tool } : {}) });
  const aviso = (mensaje: string, tool?: string): void => void hallazgos.push({ nivel: 'aviso', mensaje, ...(tool ? { tool } : {}) });
  const nombres = new Set(tools.map((t) => t.nombre));

  const capacidades = opciones.capacidades ?? CAPACIDADES;
  for (const c of capacidades) {
    if (!(c in TOOLS_POR_CAPACIDAD)) error(`capacidad desconocida: ${String(c)}`);
    else for (const tool of TOOLS_POR_CAPACIDAD[c]) if (!nombres.has(tool)) error(`falta la tool ${tool}, obligatoria con la capacidad ${c}`);
  }

  for (const t of tools) {
    const props = propiedades(t);
    if (!('contexto' in props)) error('toda tool debe recibir `contexto` (la identidad la inyecta el orquestador)', t.nombre);
    else if (!requeridos(t).includes('contexto')) error('`contexto` debe ser requerido', t.nombre);
    if (!t.descripcion.trim()) aviso('descripción vacía: el modelo elige tools por su descripción', t.nombre);
    if ('confirmation_token' in props && !esConfirmar(t.nombre)) error('solo las tools confirmar_* reciben confirmation_token', t.nombre);

    if (esPreparar(t.nombre)) {
      if (!nombres.has(confirmarDe(t.nombre))) error(`falta ${confirmarDe(t.nombre)} para cerrar el par`, t.nombre);
      if ('idempotency_key' in props) aviso('preparar_* no necesita idempotency_key: la idempotencia está en confirmar_*', t.nombre);
    } else if (esConfirmar(t.nombre)) {
      if (!nombres.has(prepararDe(t.nombre))) error(`falta ${prepararDe(t.nombre)}: una confirmación sin propuesta no tiene sentido`, t.nombre);
      for (const campo of ['proposal_id', 'confirmation_token', 'idempotency_key'] as const) {
        if (!(campo in props)) error(`falta el campo ${campo}`, t.nombre);
        else if (!requeridos(t).includes(campo)) error(`${campo} debe ser requerido`, t.nombre);
      }
    } else if (!esLectura(t.nombre)) {
      aviso('nombre fuera de convención: usar listar_/obtener_/consultar_ para lecturas y preparar_/confirmar_ para escrituras', t.nombre);
    }
  }

  const reservados = new Set<string>(CAMPOS_RESERVADOS);
  for (const t of tools) {
    for (const campo of Object.keys(propiedades(t))) {
      if (/(?:^|_)pin(?:$|_)|password|secret/i.test(campo) && !reservados.has(campo) && !esConfirmar(t.nombre)) {
        error(`el campo ${campo} parece un secreto: solo puede viajar en confirmar_* (autorizacion)`, t.nombre);
      }
    }
  }
  return { ok: !hallazgos.some((h) => h.nivel === 'error'), hallazgos };
}
