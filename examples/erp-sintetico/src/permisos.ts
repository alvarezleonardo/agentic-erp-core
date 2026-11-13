import { Permisos } from '@agentic-erp/core';

export const ROLES = ['lectura', 'operador', 'supervisor', 'gerente'] as const;
export type RolErp = (typeof ROLES)[number];

/** Quién puede preparar (y por herencia confirmar) cada escritura. Las lecturas son para todos los roles. */
export const ROLES_POR_ESCRITURA: Readonly<Record<string, readonly string[]>> = {
  preparar_ajuste_stock: ['operador', 'supervisor', 'gerente'],
  preparar_orden_compra: ['supervisor', 'gerente'],
  preparar_movimiento_caja: ['operador', 'supervisor', 'gerente'],
};

/** Roles que pueden autorizar un step-up. */
export const ROLES_AUTORIZADORES: readonly string[] = ['supervisor', 'gerente'];

/**
 * Guardrail del orquestador. El servidor MCP del ejemplo vuelve a verificar la misma tabla por su cuenta:
 * el orquestador corta antes y no le muestra al modelo tools que la persona no puede usar; el servidor es la autoridad.
 */
export const permisosDelEjemplo = (): Permisos => new Permisos({ porTool: ROLES_POR_ESCRITURA, porDefecto: 'todos' });
