import { LlmError, type LlmProvider } from '@agentic-erp/llm';

/** Un dominio al que el router puede mandar una intención. */
export interface DominioDef {
  nombre: string;
  /** Una línea: el modelo clasifica por esta descripción. */
  descripcion: string;
}

/**
 * Regla pluggable: un patrón en español que dispara un dominio. El texto se normaliza antes
 * (minúsculas y sin tildes), así que los patrones se escriben sin tildes: `/\bventas?\b|\bvendimos\b/`.
 */
export interface ReglaRouter {
  dominio: string;
  patron: RegExp;
  /** Si dispara, es el único dominio del plan (por ejemplo una pregunta analítica que no se mezcla con operación). */
  exclusiva?: boolean;
  /** Si este patrón también aparece en el texto, la regla no aplica. */
  salvo?: RegExp;
}

/** `comando`: no hubo router, la persona mandó una tool directa (modo directo). */
export type OrigenPlan = 'reglas' | 'llm' | 'sin_clasificar' | 'comando';

export interface PlanRouter {
  /** Dominios en el orden en que hay que ejecutarlos. */
  plan: string[];
  origen: OrigenPlan;
  /** Entidades obvias extraídas del texto por los extractores del despliegue (por ejemplo un número de documento). */
  entidades: Record<string, string>;
  /** Presente cuando el modelo no estuvo disponible y no hubo regla. */
  motivo?: 'llm_no_disponible';
}

export interface OpcionesRouter {
  dominios: readonly DominioDef[];
  reglas: readonly ReglaRouter[];
  /** Sin proveedor, lo que no matchea ninguna regla queda `sin_clasificar`. */
  llm?: LlmProvider;
  /** Extractores de entidades: nombre -> función sobre el texto original. */
  extractores?: Record<string, (texto: string) => string | undefined>;
  /** Contexto del negocio para el prompt del clasificador (una o dos oraciones). */
  descripcionDelNegocio?: string;
}

export const normalizar = (texto: string): string => texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Router híbrido (ADR-002): reglas para lo trivial —gratis y determinista— y un modelo rápido solo
 * para lo que las reglas no cubren. Nunca resuelve el pedido: solo clasifica.
 */
export class Router {
  private readonly orden: string[];

  constructor(private readonly o: OpcionesRouter) {
    this.orden = o.dominios.map((d) => d.nombre);
    const conocidos = new Set(this.orden);
    for (const r of o.reglas) if (!conocidos.has(r.dominio)) throw new Error(`La regla apunta al dominio desconocido "${r.dominio}"`);
  }

  private entidades(texto: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, fn] of Object.entries(this.o.extractores ?? {})) {
      const v = fn(texto);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /** Solo reglas (sin modelo). `undefined` si ninguna dispara. */
  enrutarPorReglas(texto: string): PlanRouter | undefined {
    const t = normalizar(texto);
    const disparadas = this.o.reglas.filter((r) => r.patron.test(t) && !(r.salvo && r.salvo.test(t)));
    if (disparadas.length === 0) return undefined;
    const exclusiva = disparadas.find((r) => r.exclusiva);
    const dominios = exclusiva ? [exclusiva.dominio] : this.orden.filter((d) => disparadas.some((r) => r.dominio === d));
    return { plan: dominios, origen: 'reglas', entidades: this.entidades(texto) };
  }

  async enrutar(texto: string): Promise<PlanRouter> {
    const porReglas = this.enrutarPorReglas(texto);
    if (porReglas) return porReglas;
    const entidades = this.entidades(texto);
    if (!this.o.llm) return { plan: [], origen: 'sin_clasificar', entidades };

    let respuesta;
    try {
      respuesta = await this.o.llm.generate({
        system: this.promptDelClasificador(),
        messages: [{ role: 'user', text: texto }],
        toolMode: 'any',
        etiqueta: 'router',
        tools: [
          {
            name: 'plan_intent',
            description: 'Devuelve los dominios que hay que ejecutar, en orden.',
            parameters: {
              type: 'object',
              properties: { dominios: { type: 'array', items: { type: 'string', enum: [...this.orden] }, description: 'Dominios en orden de ejecución. Vacío si no se entiende.' } },
              required: ['dominios'],
            },
          },
        ],
      });
    } catch (e) {
      if (e instanceof LlmError) return { plan: [], origen: 'sin_clasificar', entidades, motivo: 'llm_no_disponible' };
      throw e;
    }
    const llamada = respuesta.toolCalls.find((c) => c.name === 'plan_intent');
    const crudos = Array.isArray(llamada?.args['dominios']) ? (llamada.args['dominios'] as unknown[]) : [];
    const plan = this.orden.filter((d) => crudos.includes(d));
    return { plan, origen: plan.length ? 'llm' : 'sin_clasificar', entidades };
  }

  private promptDelClasificador(): string {
    const dominios = this.o.dominios.map((d) => `- ${d.nombre}: ${d.descripcion}`).join('\n');
    return `Sos el router de intención de un asistente de ERP. ${this.o.descripcionDelNegocio ?? ''}\nTu único trabajo es clasificar el pedido de la persona en uno o más dominios, en el orden en que hay que ejecutarlos, llamando a la función plan_intent.\nDominios:\n${dominios}\nReglas: devolvé solo los dominios que realmente hacen falta; si una frase es de un solo dominio, devolvé uno solo. Si el pedido no se entiende, es un saludo o no corresponde a ningún dominio, devolvé una lista vacía. No resuelvas el pedido: solo clasificá.`;
  }
}
