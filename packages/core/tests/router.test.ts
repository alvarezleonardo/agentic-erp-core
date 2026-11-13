import { LlmError, ScriptedProvider, llamada } from '@agentic-erp/llm';
import { describe, expect, it } from 'vitest';
import { Router, type DominioDef, type ReglaRouter } from '../src/index.js';

const dominios: DominioDef[] = [
  { nombre: 'ventas', descripcion: 'Ventas' },
  { nombre: 'stock', descripcion: 'Stock' },
  { nombre: 'caja', descripcion: 'Caja' },
];
const reglas: ReglaRouter[] = [
  { dominio: 'ventas', patron: /\bventas?\b|\bvendimos\b/ },
  { dominio: 'stock', patron: /\bstock\b|\bexistencias?\b/, salvo: /\bsin stock\b/ },
  { dominio: 'caja', patron: /\bcaja\b/ },
  { dominio: 'ventas', exclusiva: true, patron: /\banomali\w*/ },
];

describe('Router por reglas', () => {
  const router = new Router({ dominios, reglas });

  it('normaliza tildes y mayúsculas antes de probar los patrones', () => {
    expect(router.enrutarPorReglas('¿Cuánto VENDIMOS?')?.plan).toEqual(['ventas']);
  });

  it('devuelve los dominios en el orden canónico, no en el orden del texto', () => {
    expect(router.enrutarPorReglas('cómo está la caja y el stock')?.plan).toEqual(['stock', 'caja']);
  });

  it('una regla exclusiva deja un solo dominio aunque otras también disparen', () => {
    expect(router.enrutarPorReglas('hay anomalías en la caja y en el stock')?.plan).toEqual(['ventas']);
  });

  it('«salvo» desactiva la regla', () => {
    expect(router.enrutarPorReglas('productos sin stock')).toBeUndefined();
  });

  it('devuelve undefined si no dispara ninguna regla', () => {
    expect(router.enrutarPorReglas('hola')).toBeUndefined();
  });

  it('rechaza reglas que apuntan a un dominio inexistente', () => {
    expect(() => new Router({ dominios, reglas: [{ dominio: 'rrhh', patron: /x/ }] })).toThrowError(/rrhh/);
  });

  it('extrae entidades con los extractores del despliegue', () => {
    const r = new Router({ dominios, reglas, extractores: { articulo: (t) => /art_\d+/.exec(t)?.[0] } });
    expect(r.enrutarPorReglas('stock de art_004')?.entidades).toEqual({ articulo: 'art_004' });
  });
});

describe('Router híbrido', () => {
  it('no llama al modelo cuando una regla alcanza', async () => {
    const llm = new ScriptedProvider([]);
    const plan = await new Router({ dominios, reglas, llm }).enrutar('cuánto vendimos');
    expect(plan.origen).toBe('reglas');
    expect(llm.llamadas).toHaveLength(0);
  });

  it('cae al modelo cuando no hay regla y se queda solo con dominios conocidos, en orden canónico', async () => {
    const llm = new ScriptedProvider([llamada('plan_intent', { dominios: ['caja', 'inventado', 'ventas'] })]);
    const plan = await new Router({ dominios, reglas, llm }).enrutar('cómo venimos con todo');
    expect(plan).toMatchObject({ origen: 'llm', plan: ['ventas', 'caja'] });
    const pedido = llm.llamadas[0]!;
    expect(pedido.etiqueta).toBe('router');
    expect(pedido.system).toContain('- stock: Stock');
    expect(JSON.stringify(pedido.tools)).toContain('"enum":["ventas","stock","caja"]');
  });

  it('queda sin_clasificar si el modelo devuelve una lista vacía', async () => {
    const llm = new ScriptedProvider([llamada('plan_intent', { dominios: [] })]);
    expect(await new Router({ dominios, reglas, llm }).enrutar('hola')).toMatchObject({ origen: 'sin_clasificar', plan: [] });
  });

  it('sin modelo y sin regla queda sin_clasificar; con el modelo caído lo indica', async () => {
    expect((await new Router({ dominios, reglas }).enrutar('hola')).origen).toBe('sin_clasificar');
    const caido = new ScriptedProvider([() => { throw new LlmError('caído', undefined, 'LLM_NO_DISPONIBLE'); }]);
    expect(await new Router({ dominios, reglas, llm: caido }).enrutar('hola')).toMatchObject({ origen: 'sin_clasificar', motivo: 'llm_no_disponible' });
  });
});
