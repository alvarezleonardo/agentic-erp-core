import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { esObjeto, type ContextoSesion, type Obj, type ResultadoTool, type ToolClient, type ToolMcp } from '@agentic-erp/mcp-contract';

/** Lo mínimo que necesita un servidor para conectarse en memoria (el `Server` o `McpServer` del SDK). */
export interface ServidorConectable {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/**
 * Cliente de UN servidor MCP, expuesto como `ToolClient`. Inyecta `contexto` en las tools que lo declaran,
 * traduce la respuesta MCP a `{ ok, datos }` y convierte `isError` en un `ErrorTool` del contrato.
 */
export class ClienteMcp implements ToolClient {
  private tools: ToolMcp[] | undefined;

  private constructor(private readonly client: Client) {}

  static async conectar(transport: Transport, nombre = 'agentic-erp'): Promise<ClienteMcp> {
    const client = new Client({ name: nombre, version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    return new ClienteMcp(client);
  }

  /** Lanza un servidor MCP como proceso hijo y habla con él por stdio. */
  static stdio(comando: string, args: string[] = [], env?: Record<string, string>): Promise<ClienteMcp> {
    return ClienteMcp.conectar(new StdioClientTransport({ command: comando, args, ...(env ? { env } : {}) }));
  }

  /** Habla con un servidor MCP por Streamable HTTP. */
  static http(url: string): Promise<ClienteMcp> {
    return ClienteMcp.conectar(new StreamableHTTPClientTransport(new URL(url)));
  }

  /** Conecta un servidor que corre en este mismo proceso (pruebas, evals, demos), con el protocolo MCP real de por medio. */
  static async enMemoria(servidor: ServidorConectable): Promise<ClienteMcp> {
    const [cliente, srv] = InMemoryTransport.createLinkedPair();
    await servidor.connect(srv);
    return ClienteMcp.conectar(cliente);
  }

  async listarTools(): Promise<ToolMcp[]> {
    const out: ToolMcp[] = [];
    let cursor: string | undefined;
    do {
      const pagina = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const t of pagina.tools) out.push({ nombre: t.name, descripcion: t.description ?? '', esquema: t.inputSchema as Obj });
      cursor = pagina.nextCursor;
    } while (cursor);
    this.tools = out;
    return out;
  }

  async llamar(nombre: string, args: Obj, contexto: ContextoSesion | undefined): Promise<ResultadoTool> {
    const tools = this.tools ?? (await this.listarTools());
    const def = tools.find((t) => t.nombre === nombre);
    const recibeContexto = esObjeto(def?.esquema['properties']) && 'contexto' in def.esquema['properties'];
    const completos: Obj = contexto && recibeContexto ? { ...args, contexto } : { ...args };
    const res = await this.client.callTool({ name: nombre, arguments: completos });
    const datos = extraerDatos(res as { content?: unknown; structuredContent?: unknown; isError?: boolean });
    return { ok: res.isError !== true, datos };
  }

  async cerrar(): Promise<void> {
    await this.client.close();
  }
}

function extraerDatos(res: { content?: unknown; structuredContent?: unknown; isError?: boolean }): Obj {
  if (esObjeto(res.structuredContent)) return res.structuredContent;
  const texto = Array.isArray(res.content) ? (res.content.find((c): c is { type: 'text'; text: string } => esObjeto(c) && c['type'] === 'text')?.text ?? '') : '';
  try {
    const v: unknown = JSON.parse(texto);
    if (esObjeto(v)) return v;
  } catch {
    // no era JSON: se informa como error genérico más abajo
  }
  return res.isError ? { codigo: 'ERROR_SERVIDOR', mensaje: texto || 'El servidor devolvió un error sin detalle.' } : { valor: texto };
}
