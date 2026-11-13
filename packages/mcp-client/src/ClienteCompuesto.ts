import type { ContextoSesion, Obj, ResultadoTool, ToolClient, ToolMcp } from '@agentic-erp/mcp-contract';

/**
 * Une varios servidores MCP detrás de un solo puerto. `listarTools` devuelve la unión (si dos publican el mismo nombre
 * gana el primero) y `llamar` enruta cada tool al servidor que la publica. Así un ERP, un servidor de métricas y uno
 * de documentos se usan con la misma maquinaria. No cierra los clientes que envuelve: eso lo hace quien los creó.
 */
export class ClienteCompuesto implements ToolClient {
  private readonly ruta = new Map<string, ToolClient>();
  /** Nombres que más de un servidor publicó (solo se usa el del primero). */
  readonly duplicadas: string[] = [];

  constructor(private readonly clientes: readonly ToolClient[]) {}

  async listarTools(): Promise<ToolMcp[]> {
    const out: ToolMcp[] = [];
    this.ruta.clear();
    this.duplicadas.length = 0;
    for (const c of this.clientes) {
      for (const t of await c.listarTools()) {
        if (this.ruta.has(t.nombre)) {
          this.duplicadas.push(t.nombre);
          continue;
        }
        this.ruta.set(t.nombre, c);
        out.push(t);
      }
    }
    return out;
  }

  async llamar(nombre: string, args: Obj, contexto: ContextoSesion | undefined): Promise<ResultadoTool> {
    if (this.ruta.size === 0) await this.listarTools();
    const c = this.ruta.get(nombre);
    if (!c) return { ok: false, datos: { codigo: 'TOOL_DESCONOCIDA', mensaje: `No existe la tool ${nombre}`, accion_sugerida: 'Usar una tool del catálogo.' } };
    return c.llamar(nombre, args, contexto);
  }

  async cerrar(): Promise<void> {
    // Los clientes envueltos los cierra su dueño.
  }
}
