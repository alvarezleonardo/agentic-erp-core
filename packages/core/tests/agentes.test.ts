import { describe, expect, it } from 'vitest';
import { MAX_TOOLS_POR_AGENTE, REGLAS_COMUNES, reglasComunes, RegistroAgentes, definirAgente } from '../src/index.js';

const base = { nombre: 'a', dominio: 'a', descripcion: 'A', prompt: 'ÁREA A', tools: ['leer_x'], componentes: ['DataTable'] };

describe('definirAgente', () => {
  it('el registro es configurable y por defecto es español rioplatense', () => {
    expect(REGLAS_COMUNES).toContain('español rioplatense');
    expect(reglasComunes()).toBe(REGLAS_COMUNES);
    expect(reglasComunes({ registro: 'español neutro' })).toContain('Hablás en español neutro,');
    const a = definirAgente({ ...base, registro: 'español neutro' });
    expect(a.systemPrompt).toContain('español neutro');
    expect(a.systemPrompt).not.toContain('rioplatense');
    expect(a).not.toHaveProperty('registro');
  });

  it('antepone las reglas comunes al prompt propio', () => {
    const a = definirAgente(base);
    expect(a.systemPrompt.startsWith(REGLAS_COMUNES)).toBe(true);
    expect(a.systemPrompt.endsWith('ÁREA A')).toBe(true);
  });

  it('las reglas comunes fijan los principios y no mencionan tokens', () => {
    expect(REGLAS_COMUNES).toContain('PROPONÉS');
    expect(REGLAS_COMUNES).toContain('NUNCA calcules');
    expect(REGLAS_COMUNES.toLowerCase()).not.toContain('token');
  });

  it(`rechaza más de ${MAX_TOOLS_POR_AGENTE} tools: un agente acotado, no un enjambre ni un agente con todo`, () => {
    const tools = Array.from({ length: MAX_TOOLS_POR_AGENTE + 1 }, (_, i) => `leer_${i}`);
    expect(() => definirAgente({ ...base, tools })).toThrowError(/máximo es 15/);
    expect(() => definirAgente({ ...base, tools: tools.slice(0, MAX_TOOLS_POR_AGENTE) })).not.toThrow();
  });

  it('rechaza confirmar_*, tools repetidas y agentes sin componentes', () => {
    expect(() => definirAgente({ ...base, tools: ['confirmar_x'] })).toThrowError(/confirmaciones las hace la persona/);
    expect(() => definirAgente({ ...base, tools: ['leer_x', 'leer_x'] })).toThrowError(/repite/);
    expect(() => definirAgente({ ...base, componentes: [] })).toThrowError(/componentes/);
  });
});

describe('RegistroAgentes', () => {
  it('no admite dominios repetidos', () => {
    const a = definirAgente(base);
    expect(() => new RegistroAgentes([a, a])).toThrowError(/duplicado/);
  });

  it('detecta tools inexistentes y preparar_* sin su confirmar_* en el servidor', () => {
    const reg = new RegistroAgentes([definirAgente({ ...base, tools: ['leer_x', 'preparar_y', 'no_existe'] })]);
    expect(reg.validarContraCatalogo(['leer_x', 'preparar_y'])).toEqual(['a: la tool no_existe no existe en el servidor', 'a: preparar_y no tiene su confirmar_']);
    expect(reg.validarContraCatalogo(['leer_x', 'preparar_y', 'confirmar_y', 'no_existe'])).toEqual([]);
  });
});
