import { createHash, randomUUID } from 'node:crypto';
import type { LlmToolDeclaration } from '@agentic-erp/llm';
import { CAMPOS_RESERVADOS, esquemaParaModelo, type Autorizacion, type ContextoSesion, type ResultadoTool, type ToolClient, type ToolMcp } from '@agentic-erp/mcp-contract';
import { esObjeto, type Obj } from './util.js';

/** El modelo no debe saber que existe un token: se limpian las menciones de las descripciones del servidor. */
export function descripcionParaLlm(d: string): string {
  return d.replace(/\s+(?:y|e)\s+un\s+confirmation_token/gi, '').replace(/confirmation_token/gi, 'confirmación');
}

interface Registro {
  tool: ToolMcp;
  declaracion: LlmToolDeclaration;
  inyectados: string[];
}

/**
 * Catálogo de tools del MCP con las dos caras: lo que ve el modelo (sin `contexto`, sin
 * `idempotency_key`, sin `id_intencion`) y lo que se manda al servidor (con todo reinyectado).
 */
export class Herramientas {
  private readonly registro = new Map<string, Registro>();

  constructor(
    tools: readonly ToolMcp[],
    private readonly mcp: ToolClient,
  ) {
    for (const t of tools) {
      const props = esObjeto(t.esquema['properties']) ? t.esquema['properties'] : {};
      const inyectados = CAMPOS_RESERVADOS.filter((c) => c in props);
      this.registro.set(t.nombre, {
        tool: t,
        inyectados,
        declaracion: { name: t.nombre, description: descripcionParaLlm(t.descripcion), parameters: esquemaParaModelo(t.esquema) },
      });
    }
  }

  static async desde(mcp: ToolClient): Promise<Herramientas> {
    return new Herramientas(await mcp.listarTools(), mcp);
  }

  nombres(): string[] {
    return [...this.registro.keys()];
  }

  existe(nombre: string): boolean {
    return this.registro.has(nombre);
  }

  declaracionesPara(nombres: readonly string[]): LlmToolDeclaration[] {
    return nombres.map((n) => {
      const r = this.registro.get(n);
      if (!r) throw new Error(`tool desconocida: ${n}`);
      return r.declaracion;
    });
  }

  /**
   * Llama una tool por el camino del modelo. Lo que el modelo haya mandado en los campos reservados se
   * descarta y se reemplaza. Devuelve también los argumentos efectivos sin los campos inyectados.
   */
  async invocar(
    nombre: string,
    argsModelo: Obj,
    contexto: ContextoSesion,
    ref: { intentId: string; callId: string },
  ): Promise<{ resultado: ResultadoTool; argsLimpios: Obj; reservadosDescartados: string[] }> {
    const r = this.registro.get(nombre);
    if (!r) throw new Error(`tool desconocida: ${nombre}`);
    const argsLimpios: Obj = { ...argsModelo };
    const reservadosDescartados: string[] = [];
    for (const campo of CAMPOS_RESERVADOS) {
      if (campo in argsLimpios) {
        delete argsLimpios[campo];
        reservadosDescartados.push(campo);
      }
    }
    const completos: Obj = { ...argsLimpios };
    if (r.inyectados.includes('idempotency_key')) {
      completos['idempotency_key'] = `idk_${createHash('sha256').update(`${ref.intentId}:${ref.callId}`).digest('hex').slice(0, 32)}`;
    }
    if (r.inyectados.includes('id_intencion')) completos['id_intencion'] = `int_${randomUUID()}`;
    const resultado = await this.mcp.llamar(nombre, completos, { ...contexto, origen: 'agente' });
    return { resultado, argsLimpios, reservadosDescartados };
  }

  /** Llamada del propio orquestador a un confirmar_*: el token y la clave salen del almacén y del toque humano, nunca del modelo. */
  async confirmar(
    nombre: string,
    args: { proposal_id: string; confirmation_token: string; idempotency_key: string; autorizacion?: Autorizacion },
    contexto: ContextoSesion,
  ): Promise<ResultadoTool> {
    if (!this.registro.has(nombre)) throw new Error(`tool desconocida: ${nombre}`);
    return this.mcp.llamar(nombre, { ...args }, { ...contexto, origen: 'humano' });
  }
}
