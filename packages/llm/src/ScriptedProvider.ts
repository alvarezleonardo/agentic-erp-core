import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from './LlmProvider.js';

export type PasoGuion = LlmResponse | ((req: LlmRequest, indice: number) => LlmResponse);

const clonar = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

let contadorIds = 0;

/** Atajo para armar una respuesta con una llamada a función. */
export function llamada(name: string, args: Record<string, unknown>, id?: string): LlmResponse {
  const call: LlmToolCall = { id: id ?? `call_${name}_${++contadorIds}`, name, args };
  return { toolCalls: [call] };
}

/**
 * Proveedor para pruebas: reproduce un guion de respuestas en orden y REGISTRA cada petición
 * que recibe (copia profunda), para poder afirmar que el modelo nunca vio un token, un PIN
 * o un monto que no debía ver.
 */
export class ScriptedProvider implements LlmProvider {
  readonly nombre = 'scripted';
  readonly llamadas: LlmRequest[] = [];
  private cursor = 0;

  constructor(private readonly guion: PasoGuion[] = []) {}

  agregar(...pasos: PasoGuion[]): void {
    this.guion.push(...pasos);
  }

  get pendientes(): number {
    return this.guion.length - this.cursor;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.llamadas.push(clonar(req));
    const paso = this.guion[this.cursor];
    if (!paso) throw new LlmError(`ScriptedProvider: se agotó el guion en la llamada ${this.cursor + 1} (${req.etiqueta})`);
    this.cursor++;
    const respuesta = typeof paso === 'function' ? paso(clonar(req), this.cursor - 1) : paso;
    return clonar(respuesta);
  }

  /** Todo lo que el modelo recibió, serializado (para búsquedas de texto en pruebas). */
  entradasSerializadas(): string {
    return JSON.stringify(this.llamadas);
  }
}

/** Último resultado de tool con ese nombre dentro de los mensajes de la petición. */
export function ultimoResultado(req: LlmRequest, tool: string): Record<string, any> {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === 'tool') {
      const r = m.results.find((x) => x.name === tool);
      if (r) return r.result as Record<string, any>;
    }
  }
  throw new Error(`no hay resultado previo de ${tool}`);
}

/** Último resultado de cualquier tool que no sea una directiva final. */
export function ultimoResultadoDeLectura(req: LlmRequest): Record<string, any> | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === 'tool') {
      const r = [...m.results].reverse().find((x) => !['render_ui', 'clarify', 'report_error'].includes(x.name));
      if (r) return r.result as Record<string, any>;
    }
  }
  return undefined;
}
