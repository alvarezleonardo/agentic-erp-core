import { describe, expect, it } from 'vitest';
import { hashPin, verificarPin } from '../src/index.js';

describe('hashPin / verificarPin (referencia para el servidor)', () => {
  it('verifica el PIN correcto y rechaza uno incorrecto', () => {
    const h = hashPin('2468');
    expect(verificarPin('2468', h)).toBe(true);
    expect(verificarPin('2469', h)).toBe(false);
    expect(verificarPin('', h)).toBe(false);
  });

  it('el hash no contiene el PIN, usa formato sal:hash y la sal aleatoria distingue dos hashes del mismo PIN', () => {
    const a = hashPin('2468');
    const b = hashPin('2468');
    expect(a).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(a).not.toContain('2468');
    expect(a).not.toBe(b);
    expect(verificarPin('2468', a) && verificarPin('2468', b)).toBe(true);
  });

  it('con sal explícita es determinista (útil para pruebas)', () => {
    expect(hashPin('1357', 'sal_fija')).toBe(hashPin('1357', 'sal_fija'));
    expect(hashPin('1357', 'sal_fija')).not.toBe(hashPin('1357', 'otra_sal'));
    expect(() => hashPin('1357', '')).toThrow();
    expect(() => hashPin('1357', 'a:b')).toThrow();
  });

  it('un hash mal formado no verifica nada y no lanza', () => {
    for (const malo of ['', 'sin_separador', ':', 'sal:', ':abcd', 'sal:zzzz', 'sal:abcd:extra']) expect(verificarPin('2468', malo)).toBe(false);
  });
});
