import { LlmError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall, type Obj } from './LlmProvider.js';
import { costoUsd, precioDe, preciosDeEntorno, type PrecioModelo } from './presupuesto.js';

type Fetch = typeof fetch;

export interface OpcionesOpenAiCompatible {
  /** Por ejemplo https://api.example.com/v1 (sin la barra final). */
  baseUrl: string;
  apiKey: string;
  modelo: string;
  precios?: Record<string, PrecioModelo>;
  timeoutMs?: number;
  /** Inyectable para pruebas. */
  fetchImpl?: Fetch;
}

/**
 * Adaptador de ejemplo para cualquier endpoint compatible con `/chat/completions` con tool calling.
 * No trae claves: salen de las variables de entorno (ver `desdeEntorno`). Es una referencia, no un SDK:
 * cada despliegue puede reemplazarlo implementando `LlmProvider`.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly nombre: string;
  private readonly fetchImpl: Fetch;
  private readonly precios: Record<string, PrecioModelo>;

  constructor(private readonly o: OpcionesOpenAiCompatible) {
    this.nombre = `openai-compatible:${o.modelo}`;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.precios = { ...preciosDeEntorno(), ...(o.precios ?? {}) };
  }

  /** Lee LLM_BASE_URL, LLM_API_KEY y LLM_MODEL. Falla con un mensaje claro si falta alguna. */
  static desdeEntorno(env: Record<string, string | undefined> = process.env, extra: Partial<OpcionesOpenAiCompatible> = {}): OpenAiCompatibleProvider {
    const faltan = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].filter((k) => !env[k]);
    if (faltan.length) throw new LlmError(`Faltan variables de entorno: ${faltan.join(', ')} (ver .env.example)`, undefined, 'LLM_NO_DISPONIBLE');
    return new OpenAiCompatibleProvider({ baseUrl: env['LLM_BASE_URL']!, apiKey: env['LLM_API_KEY']!, modelo: env['LLM_MODEL']!, ...extra });
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const cuerpo: Obj = {
      model: this.o.modelo,
      messages: [{ role: 'system', content: req.system }, ...req.messages.flatMap(aMensajes)],
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: req.toolMode === 'any' ? 'required' : 'auto',
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.o.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new LlmError('No se pudo contactar al modelo', e, 'LLM_NO_DISPONIBLE');
    }
    if (!res.ok) throw new LlmError(`El modelo respondió ${res.status}`, await res.text().catch(() => ''), 'LLM_NO_DISPONIBLE');
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new LlmError('Respuesta del modelo sin mensaje', json, 'LLM_NO_DISPONIBLE');
    const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parsearArgs(c.function.arguments) }));
    const entrada = json.usage?.prompt_tokens ?? 0;
    const salida = json.usage?.completion_tokens ?? 0;
    return {
      ...(msg.content ? { text: msg.content } : {}),
      toolCalls,
      uso: { modelo: this.o.modelo, tokensEntrada: entrada, tokensSalida: salida, costoUsd: costoUsd(precioDe(this.o.modelo, this.precios), entrada, salida) },
    };
  }
}

function parsearArgs(crudo: string): Obj {
  try {
    const v: unknown = JSON.parse(crudo || '{}');
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
  } catch {
    return {};
  }
}

function aMensajes(m: LlmMessage): Obj[] {
  if (m.role === 'user') return [{ role: 'user', content: m.text }];
  if (m.role === 'assistant') {
    return [
      {
        role: 'assistant',
        content: m.text ?? null,
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      },
    ];
  }
  return m.results.map((r) => ({ role: 'tool', tool_call_id: r.callId, content: JSON.stringify(r.result) }));
}
