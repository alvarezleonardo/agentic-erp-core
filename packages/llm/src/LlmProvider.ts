/** Interfaz propia de acceso al modelo: los agentes no conocen al proveedor (ADR-002). */

export type Obj = Record<string, unknown>;

export interface LlmToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema (objeto) de los parámetros que ve el modelo. */
  parameters: Obj;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Obj;
}

export interface LlmToolResult {
  callId: string;
  name: string;
  /** Resultado ya saneado (sin tokens ni PIN). */
  result: unknown;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolCalls: LlmToolCall[]; /** Contenido nativo del proveedor, se reenvía tal cual. */ raw?: unknown }
  | { role: 'tool'; results: LlmToolResult[] };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDeclaration[];
  /** 'any' obliga a responder con una llamada a función. */
  toolMode: 'auto' | 'any';
  /** Quién llama ('router', 'agente:ventas'): sirve para trazas y guiones de prueba. */
  etiqueta: string;
}

/** Lo que costó una llamada (estimado con la tabla de precios). Solo lo informan los proveedores que cobran. */
export interface UsoRespuesta {
  modelo: string;
  tokensEntrada: number;
  tokensSalida: number;
  costoUsd: number;
}

export interface LlmResponse {
  text?: string;
  toolCalls: LlmToolCall[];
  raw?: unknown;
  uso?: UsoRespuesta;
}

export interface LlmProvider {
  readonly nombre: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
}

export type CodigoLlm = 'PRESUPUESTO_AGOTADO' | 'LLM_NO_DISPONIBLE';

export class LlmError extends Error {
  constructor(
    mensaje: string,
    readonly causa?: unknown,
    readonly codigo?: CodigoLlm,
  ) {
    super(mensaje);
    this.name = 'LlmError';
  }
}
