import type { LlmToolDeclaration } from '@agentic-erp/llm';
import { esObjeto, type Obj } from './util.js';

/** Pseudo-tools finales que declara el orquestador (no existen en el MCP). Toda corrida termina en una. */
export const FINALES = ['render_ui', 'clarify', 'report_error'] as const;
export type NombreFinal = (typeof FINALES)[number];

export const esFinal = (nombre: string): nombre is NombreFinal => (FINALES as readonly string[]).includes(nombre);

export interface DirectivaRender {
  tipo: 'render_ui';
  component: string;
  proposal_id?: string;
  data?: Obj;
  speech?: string;
  actions?: { id: string; label?: string }[];
}
export interface DirectivaClarify {
  tipo: 'clarify';
  pregunta: string;
  opciones: { id: string; etiqueta?: string }[];
}
export interface DirectivaError {
  tipo: 'report_error';
  codigo: string;
  mensaje: string;
  accion_sugerida?: string;
}
export type Directiva = DirectivaRender | DirectivaClarify | DirectivaError;

export function declaracionesFinales(componentes: readonly string[]): LlmToolDeclaration[] {
  return [
    {
      name: 'render_ui',
      description:
        'Directiva final: muestra un componente de UI. Para componentes con datos del ERP pasá SOLO proposal_id (el id que devolvió un preparar_* o el source_id de una lectura); el servidor completa todos los datos y montos. En data solo van campos no sensibles. speech: una oración sin cifras.',
      parameters: {
        type: 'object',
        properties: {
          component: { type: 'string', enum: [...componentes], description: 'Componente del catálogo.' },
          proposal_id: { type: 'string', description: 'proposal_id de un preparar_* o source_id de una lectura de la que se hidrata el componente.' },
          data: { type: 'object', description: 'Solo campos no sensibles. Nunca montos, totales ni claves.' },
          speech: { type: 'string', description: 'Una oración corta, sin importes.' },
          actions: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id'] },
            description: 'Opcional: ids de acciones del catálogo del componente que querés ofrecer.',
          },
        },
        required: ['component'],
      },
    },
    {
      name: 'clarify',
      description: 'Directiva final: preguntá cuando hay ambigüedad. Las opciones deben ser ids reales devueltos por un tool (por ejemplo producto_id de un listado). Nunca inventes opciones.',
      parameters: {
        type: 'object',
        properties: {
          pregunta: { type: 'string', description: 'Pregunta breve, sin importes.' },
          opciones: {
            type: 'array',
            minItems: 2,
            items: { type: 'object', properties: { id: { type: 'string', description: 'Id tomado de un resultado de tool.' }, etiqueta: { type: 'string' } }, required: ['id'] },
          },
        },
        required: ['pregunta', 'opciones'],
      },
    },
    {
      name: 'report_error',
      description: 'Directiva final: informa que no se pudo resolver la intención. Usalo con el código del error del tool cuando exista.',
      parameters: {
        type: 'object',
        properties: {
          codigo: { type: 'string', description: 'Código del error del tool (ej. NO_ENCONTRADO) o AGENTE_SIN_RESOLUCION.' },
          mensaje: { type: 'string', description: 'Explicación corta y sin jerga técnica, sin importes.' },
          accion_sugerida: { type: 'string' },
        },
        required: ['codigo', 'mensaje'],
      },
    },
  ];
}

const str = (v: unknown): v is string => typeof v === 'string';

/** Convierte la llamada del modelo en una directiva tipada; devuelve un error legible si la forma es inválida. */
export function parsearDirectiva(nombre: NombreFinal, args: Obj): { ok: true; directiva: Directiva } | { ok: false; error: string } {
  if (nombre === 'render_ui') {
    if (!str(args['component'])) return { ok: false, error: 'render_ui requiere component (string)' };
    // render_ui con Clarification trae el mismo esquema que clarify: se convierte en vez de gastar un paso en el rechazo.
    if (args['component'] === 'Clarification' && esObjeto(args['data'])) {
      const dat = args['data'];
      if (str(dat['pregunta']) && Array.isArray(dat['opciones'])) return parsearDirectiva('clarify', { pregunta: dat['pregunta'], opciones: dat['opciones'] });
    }
    const d: DirectivaRender = { tipo: 'render_ui', component: args['component'] };
    if (str(args['proposal_id'])) d.proposal_id = args['proposal_id'];
    if (args['data'] !== undefined) {
      if (!esObjeto(args['data'])) return { ok: false, error: 'data debe ser un objeto' };
      d.data = args['data'];
    }
    if (str(args['speech'])) d.speech = args['speech'];
    if (Array.isArray(args['actions'])) {
      d.actions = args['actions'].filter((a): a is Obj => esObjeto(a) && str(a['id'])).map((a) => ({ id: a['id'] as string, ...(str(a['label']) ? { label: a['label'] } : {}) }));
    }
    return { ok: true, directiva: d };
  }
  if (nombre === 'clarify') {
    if (!str(args['pregunta'])) return { ok: false, error: 'clarify requiere pregunta' };
    if (!Array.isArray(args['opciones'])) return { ok: false, error: 'clarify requiere opciones (lista)' };
    const opciones = args['opciones'].filter((o): o is Obj => esObjeto(o) && str(o['id'])).map((o) => ({ id: o['id'] as string, ...(str(o['etiqueta']) ? { etiqueta: o['etiqueta'] } : {}) }));
    return { ok: true, directiva: { tipo: 'clarify', pregunta: args['pregunta'], opciones } };
  }
  if (!str(args['codigo']) || !str(args['mensaje'])) return { ok: false, error: 'report_error requiere codigo y mensaje' };
  return { ok: true, directiva: { tipo: 'report_error', codigo: args['codigo'], mensaje: args['mensaje'], ...(str(args['accion_sugerida']) ? { accion_sugerida: args['accion_sugerida'] } : {}) } };
}
