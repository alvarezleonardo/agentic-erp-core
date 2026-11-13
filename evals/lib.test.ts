import { describe, expect, it } from 'vitest';
import { llamada, ScriptedProvider } from '@agentic-erp/llm';
import { cargarFrases, correrFrase, desglosar, generarReporte, MedidorUso, textoCosto, type ResultadoFrase } from './lib.js';

const base = (o: Partial<ResultadoFrase>): ResultadoFrase => ({
  id: 'x-01', texto: 't', ok: true, fallas: [], origen: 'reglas', plan: ['ventas'], tools: [], componente: 'KpiTiles', llamadasAlModelo: 0,
  routerOk: true, planOk: true, toolsOk: true, componenteOk: true, ...o,
});

describe('desglose de evals', () => {
  it('cuenta router, plan, tools y componente por separado', () => {
    const d = desglosar([base({}), base({ ok: false, componenteOk: false }), base({ ok: false, routerOk: false, planOk: false, toolsOk: false })]);
    expect(d).toEqual({ total: 3, aciertos: 1, router: 2, plan: 2, tools: 2, componente: 2 });
  });

  it('caso con plan correcto pero componente incorrecto: baja el componente y no el plan', async () => {
    const f = { ...cargarFrases().find((x) => x.id === 'ven-01')! };
    f.esperado = { ...f.esperado, componente: 'DataTable' };
    const r = await correrFrase(f);
    expect(r.ok).toBe(false);
    expect(r.planOk).toBe(true);
    expect(r.routerOk).toBe(true);
    expect(r.toolsOk).toBe(true);
    expect(r.componenteOk).toBe(false);
    expect(desglosar([r])).toMatchObject({ plan: 1, componente: 0, aciertos: 0 });
  });

  it('una frase dorada acierta en todas las columnas', async () => {
    const r = await correrFrase(cargarFrases()[0]!);
    expect([r.ok, r.routerOk, r.planOk, r.toolsOk, r.componenteOk]).toEqual([true, true, true, true, true]);
  });

  it('el reporte incluye el desglose, modelo, costo y tokens', () => {
    const md = generarReporte([base({}), base({ ok: false, componenteOk: false })], { proveedor: 'p', modelo: 'm', fecha: '2026-01-01', uso: { llamadas: 2, tokensEntrada: 1500, tokensSalida: 300, costoUsd: 0.0123, sinPrecio: false } });
    expect(md).toContain('- Modelo: m');
    expect(md).toContain('- Plan (dominios coinciden): 2/2');
    expect(md).toContain('- Componente correcto: 1/2');
    expect(md).toContain('- Costo de la corrida: USD 0.0123');
    expect(md).toContain('1,500 de entrada, 300 de salida');
  });
});

describe('MedidorUso', () => {
  const resp = (modelo: string) => ({ ...llamada('x', {}), uso: { modelo, tokensEntrada: 100, tokensSalida: 10, costoUsd: 0.5 } });
  const req = { system: '', messages: [], tools: [], toolMode: 'auto' as const, etiqueta: 'test' };

  it('suma tokens y costo de la corrida', async () => {
    const m = new MedidorUso(new ScriptedProvider([resp('a'), resp('a')]), { a: { entrada: 1, salida: 2 } });
    await m.generate(req);
    await m.generate(req);
    expect(m.resumen()).toEqual({ llamadas: 2, tokensEntrada: 200, tokensSalida: 20, costoUsd: 1, sinPrecio: false });
  });

  it('sin precio configurado informa "sin precio" y no inventa costo', async () => {
    const m = new MedidorUso(new ScriptedProvider([resp('desconocido')]), {});
    await m.generate(req);
    const u = m.resumen();
    expect(u.sinPrecio).toBe(true);
    expect(u.costoUsd).toBeNull();
    expect(textoCosto(u)).toBe('sin precio');
  });

  it('un proveedor que no informa uso da costo 0', async () => {
    const m = new MedidorUso(new ScriptedProvider([llamada('x', {})]), {});
    await m.generate(req);
    expect(m.resumen()).toMatchObject({ costoUsd: 0, sinPrecio: false, tokensEntrada: 0 });
    expect(textoCosto(m.resumen())).toBe('USD 0');
  });
});
