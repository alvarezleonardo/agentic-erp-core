import type { ContextoSesion, ResultadoTool, ToolClient, ToolMcp } from '@agentic-erp/mcp-contract';
import { describe, expect, it } from 'vitest';
import { ClienteCompuesto } from '../src/index.js';

const tool = (nombre: string): ToolMcp => ({ nombre, descripcion: nombre, esquema: { type: 'object', properties: {} } });

const falso = (nombres: string[], marca: string): ToolClient & { recibido: ContextoSesion | undefined } => {
  const c = {
    recibido: undefined as ContextoSesion | undefined,
    listarTools: async () => nombres.map(tool),
    llamar: async (_n: string, _a: Record<string, unknown>, contexto: ContextoSesion | undefined): Promise<ResultadoTool> => {
      c.recibido = contexto;
      return { ok: true, datos: { marca } };
    },
    cerrar: async () => undefined,
  };
  return c;
};

describe('ClienteCompuesto', () => {
  const ctx: ContextoSesion = { tenant: 't', usuario: 'u', rol: 'r' };

  it('une los catálogos y enruta cada tool al servidor que la publica, pasando el contexto', async () => {
    const a = falso(['x', 'y'], 'A');
    const b = falso(['z'], 'B');
    const c = new ClienteCompuesto([a, b]);
    expect((await c.listarTools()).map((t) => t.nombre)).toEqual(['x', 'y', 'z']);
    expect((await c.llamar('z', {}, ctx)).datos['marca']).toBe('B');
    expect(b.recibido).toEqual(ctx);
    expect(a.recibido).toBeUndefined();
  });

  it('si dos servidores publican el mismo nombre gana el primero y queda registrado', async () => {
    const c = new ClienteCompuesto([falso(['x'], 'A'), falso(['x', 'w'], 'B')]);
    expect((await c.listarTools()).map((t) => t.nombre)).toEqual(['x', 'w']);
    expect(c.duplicadas).toEqual(['x']);
    expect((await c.llamar('x', {}, ctx)).datos['marca']).toBe('A');
  });

  it('una tool desconocida devuelve un error del contrato, no una excepción', async () => {
    const r = await new ClienteCompuesto([falso(['x'], 'A')]).llamar('nada', {}, ctx);
    expect(r).toMatchObject({ ok: false, datos: { codigo: 'TOOL_DESCONOCIDA' } });
  });
});
