import type { Obj } from './util.js';

const SIN_ID = new Set(['proposal_id', 'source_id', 'confirmation_token']);

/** Memoria de una intención: se comparte entre los agentes del plan y se descarta al cerrarla. Guarda ids, nunca montos. */
export class MemoriaIntencion {
  readonly entidades = new Map<string, string>();
  readonly completados: string[] = [];

  /** Toma los ids (`id`, `*_id`) escalares de primer nivel de un resultado de tool. */
  absorber(salida: Obj): void {
    for (const [k, v] of Object.entries(salida)) {
      if ((k === 'id' || k.endsWith('_id')) && !SIN_ID.has(k) && typeof v === 'string') this.entidades.set(k, v);
    }
  }

  texto(): string {
    if (this.entidades.size === 0) return 'sin datos todavía';
    return [...this.entidades].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export interface IntencionPrevia {
  texto: string;
  dominios: string[];
  /** Entidad sobre la que se estaba trabajando (por ejemplo un proveedor o un insumo). */
  foco?: { tipo: string; id: string };
}

/** Memoria corta de la sesión: foco y últimas intenciones (ventana de 5). Sirve para "y a ese proveedor pedile más". */
export class MemoriaSesion {
  foco: { tipo: string; id: string } | undefined;
  readonly ultimas: IntencionPrevia[] = [];

  recordar(i: IntencionPrevia): void {
    this.ultimas.push(i);
    if (this.ultimas.length > 5) this.ultimas.shift();
    if (i.foco) this.foco = i.foco;
  }

  texto(): string {
    const foco = this.foco ? `En foco: ${this.foco.tipo} ${this.foco.id}.` : 'Sin foco.';
    const prev = this.ultimas.length ? ` Intenciones previas: ${this.ultimas.map((u) => `"${u.texto}" (${u.dominios.join('+') || 'sin clasificar'})`).join('; ')}.` : '';
    return foco + prev;
  }
}
