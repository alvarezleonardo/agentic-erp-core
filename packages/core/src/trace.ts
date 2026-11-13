import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clonar, redactar } from './util.js';

export interface EventoTraza {
  ts: string;
  trace_id: string;
  intent_id: string;
  evento: string;
  [k: string]: unknown;
}

export interface OpcionesTrace {
  /** Carpeta de los .jsonl (uno por traza). Sin carpeta solo se guarda en memoria. */
  dir?: string;
  reloj?: () => Date;
}

/**
 * Traza JSONL por intención: router, agente, tools, propuestas, validaciones.
 * Todo pasa por redactar(): ningún token, PIN ni clave de API llega al disco ni a la memoria.
 */
export class Trace {
  readonly eventos: EventoTraza[] = [];
  private dirListo = false;

  constructor(private readonly opciones: OpcionesTrace = {}) {}

  registrar(traceId: string, intentId: string, evento: string, datos: Record<string, unknown> = {}): void {
    const reloj = this.opciones.reloj ?? (() => new Date());
    const e: EventoTraza = redactar({ ts: reloj().toISOString(), trace_id: traceId, intent_id: intentId, evento, ...clonar(datos) });
    this.eventos.push(e);
    const dir = this.opciones.dir;
    if (!dir) return;
    try {
      if (!this.dirListo) {
        mkdirSync(dir, { recursive: true });
        this.dirListo = true;
      }
      appendFileSync(join(dir, `${traceId}.jsonl`), `${JSON.stringify(e)}\n`);
    } catch (err) {
      console.error('[trace] no se pudo escribir la traza', (err as Error).message);
    }
  }

  porIntencion(intentId: string): EventoTraza[] {
    return this.eventos.filter((e) => e.intent_id === intentId);
  }

  serializado(): string {
    return this.eventos.map((e) => JSON.stringify(e)).join('\n');
  }
}

/** Vista acotada de un resultado de tool para trazas: la forma, no el contenido. */
export function resumenResultado(datos: unknown): unknown {
  if (datos && typeof datos === 'object' && !Array.isArray(datos)) {
    const o = datos as Record<string, unknown>;
    if (typeof o['codigo'] === 'string') return { codigo: o['codigo'], mensaje: o['mensaje'] };
    return { campos: Object.keys(o), ...(typeof o['proposal_id'] === 'string' ? { proposal_id: o['proposal_id'] } : {}) };
  }
  return { tipo: typeof datos };
}
