import { confirmarDe, esConfirmar, prepararDe } from '@agentic-erp/mcp-contract';

export interface ConfigPermisos {
  /** Roles permitidos por tool. Una tool `confirmar_x` hereda la entrada de `preparar_x` si no tiene la propia. */
  porTool?: Readonly<Record<string, readonly string[]>>;
  /** Roles para las tools sin entrada. `'todos'` (por defecto) deja pasar a cualquier rol. */
  porDefecto?: readonly string[] | 'todos';
}

/**
 * Guardrail previo de roles. Es un espejo de lo que el servidor MCP vuelve a verificar (defensa en
 * profundidad): corta antes de llamar y evita mostrarle al modelo tools que la persona no puede usar.
 * La autoridad es siempre el servidor.
 */
export class Permisos {
  constructor(private readonly cfg: ConfigPermisos = {}) {}

  puede(tool: string, rol: string): boolean {
    const porTool = this.cfg.porTool ?? {};
    const roles = porTool[tool] ?? (esConfirmar(tool) ? porTool[prepararDe(tool)] : undefined);
    if (roles) return roles.includes(rol);
    const def = this.cfg.porDefecto ?? 'todos';
    return def === 'todos' || def.includes(rol);
  }

  filtrar(tools: readonly string[], rol: string): string[] {
    return tools.filter((t) => this.puede(t, rol));
  }

  /** Para el confirmador: ¿puede este rol confirmar lo que preparó? */
  puedeConfirmar(prepararTool: string, rol: string): boolean {
    return this.puede(confirmarDe(prepararTool), rol);
  }
}
