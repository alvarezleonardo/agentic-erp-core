import { tokenCoincide } from '@agentic-erp/mcp-contract';
import { clonar, esObjeto, quitarSecretos, type Obj } from './util.js';

export type TipoFuente = 'proposal' | 'tool';
export type EstadoFuente = 'abierta' | 'confirmada' | 'reemplazada' | 'abandonada';

export interface Fuente {
  id: string;
  kind: TipoFuente;
  /** Tool que la produjo (preparar_* o una lectura). */
  tool: string;
  /** Argumentos con los que se llamó, SIN contexto. */
  args: Obj;
  /** Salida literal del tool. En propuestas incluye confirmation_token. */
  salida: Obj;
  intentId: string;
  agente: string;
  estado: EstadoFuente;
  creadaEn: number;
  confirmadaCon?: { idempotencyKey: string; resultado: Obj };
}

const TTL_LIMPIEZA_MS = 15 * 60_000;

/**
 * Guarda las salidas literales de los tools por id (proposal_id para preparar_*, source_id para lecturas).
 * Es el ÚNICO lugar donde vive el confirmation_token del lado del orquestador: el modelo solo recibe la
 * versión saneada (`paraLlm`) y el compositor hidrata el token en `data` para la superficie.
 */
export class ProposalStore {
  private readonly fuentes = new Map<string, Fuente>();
  private contador = 0;

  constructor(private readonly reloj: () => number = Date.now) {}

  /** Guarda una propuesta (salida de preparar_*). Marca como reemplazada la anterior abierta de la misma intención y tool. */
  guardarPropuesta(tool: string, args: Obj, salida: Obj, intentId: string, agente: string): Fuente {
    const id = salida['proposal_id'];
    if (typeof id !== 'string') throw new Error(`${tool} no devolvió proposal_id`);
    this.limpiar();
    for (const f of this.fuentes.values()) {
      if (f.kind === 'proposal' && f.estado === 'abierta' && f.tool === tool && f.intentId === intentId) f.estado = 'reemplazada';
    }
    const fuente: Fuente = { id, kind: 'proposal', tool, args: clonar(args), salida: clonar(salida), intentId, agente, estado: 'abierta', creadaEn: this.reloj() };
    this.fuentes.set(id, fuente);
    return fuente;
  }

  /** Guarda el resultado de una lectura. Devuelve su `source_id` (res_N). */
  guardarLectura(tool: string, args: Obj, salida: Obj, intentId: string, agente: string): Fuente {
    this.limpiar();
    const id = `res_${++this.contador}_${intentId.slice(-6)}`;
    const fuente: Fuente = { id, kind: 'tool', tool, args: clonar(args), salida: clonar(salida), intentId, agente, estado: 'abierta', creadaEn: this.reloj() };
    this.fuentes.set(id, fuente);
    return fuente;
  }

  get(id: string): Fuente | undefined {
    return this.fuentes.get(id);
  }

  /** Lecturas y propuestas de una intención (para validar opciones de Clarification). */
  deIntencion(intentId: string): Fuente[] {
    return [...this.fuentes.values()].filter((f) => f.intentId === intentId);
  }

  /** Token de una propuesta abierta. Solo lo usa el orquestador al confirmar. */
  tokenDe(id: string): string | undefined {
    const f = this.fuentes.get(id);
    if (!f || f.kind !== 'proposal' || f.estado !== 'abierta') return undefined;
    const t = f.salida['confirmation_token'];
    return typeof t === 'string' ? t : undefined;
  }

  /** Compara, en tiempo constante, el token que mandó la superficie con el guardado (en cualquier estado de la propuesta). */
  tokenCoincide(id: string, candidato: string | undefined): boolean {
    const f = this.fuentes.get(id);
    const real = f?.kind === 'proposal' ? f.salida['confirmation_token'] : undefined;
    if (typeof real !== 'string' || !candidato) return false;
    return tokenCoincide(real, candidato);
  }

  marcar(id: string, estado: EstadoFuente): void {
    const f = this.fuentes.get(id);
    if (f) f.estado = estado;
  }

  registrarConfirmacion(id: string, idempotencyKey: string, resultado: Obj): void {
    const f = this.fuentes.get(id);
    if (!f) return;
    f.estado = 'confirmada';
    f.confirmadaCon = { idempotencyKey, resultado: clonar(resultado) };
  }

  /** Abandona las propuestas abiertas de una intención (nueva intención, cancelar, descarte). */
  abandonarIntencion(intentId: string): string[] {
    const ids: string[] = [];
    for (const f of this.fuentes.values()) {
      if (f.intentId === intentId && f.kind === 'proposal' && f.estado === 'abierta') {
        f.estado = 'abandonada';
        ids.push(f.id);
      }
    }
    return ids;
  }

  /** Todos los tokens guardados (solo para que las pruebas verifiquen que no se filtraron). */
  tokensGuardados(): string[] {
    return [...this.fuentes.values()].map((f) => f.salida['confirmation_token']).filter((t): t is string => typeof t === 'string');
  }

  private limpiar(): void {
    const corte = this.reloj() - TTL_LIMPIEZA_MS;
    for (const [id, f] of this.fuentes) if (f.creadaEn < corte) this.fuentes.delete(id);
  }

  /**
   * Versión de una salida apta para el modelo: sin tokens ni campos secretos. Las lecturas llevan su
   * `source_id` para poder referenciarlas en render_ui. Las tablas largas se recortan (la fuente
   * completa queda en el almacén y es la que se muestra en pantalla).
   */
  static paraLlm(salida: Obj, fuente?: Fuente, maxFilas = 40): Obj {
    const limpia = quitarSecretos(salida);
    if (Array.isArray(limpia['filas']) && limpia['filas'].length > maxFilas) {
      limpia['filas_omitidas'] = limpia['filas'].length - maxFilas;
      limpia['filas'] = limpia['filas'].slice(0, maxFilas);
    }
    if (fuente && fuente.kind === 'tool' && esObjeto(limpia)) return { source_id: fuente.id, ...limpia };
    return limpia;
  }
}
