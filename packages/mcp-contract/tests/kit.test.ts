import { describe, expect, it } from 'vitest';
import {
  RegistroIdempotenciaMemoria,
  canonico,
  claveIdempotencia,
  consultarIdempotencia,
  emitirToken,
  hashEntrada,
  hashPayload,
  registrarIdempotencia,
  tokenCoincide,
  type ContextoSesion,
} from '../src/index.js';

const CTX: ContextoSesion = { tenant: 't1', usuario: 'ana', rol: 'operador' };

describe('canonico y hashPayload', () => {
  it('ordena las claves en todos los niveles: mismo valor, mismo texto', () => {
    expect(canonico({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'z' } })).toBe('{"a":{"c":"z","d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonico({ a: 1, b: 2 })).toBe(canonico({ b: 2, a: 1 }));
  });

  it('ignora las claves undefined, conserva null y distingue tipos', () => {
    expect(canonico({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonico([undefined, 1])).toBe('[null,1]');
    expect(canonico(1)).not.toBe(canonico('1'));
    expect(canonico(undefined)).toBe('null');
    expect(canonico('con "comillas"')).toBe('"con \\"comillas\\""');
  });

  it('hashPayload es un SHA-256 hex estable y sensible a cualquier cambio', () => {
    const h = hashPayload({ total: { monto: '10.00', moneda: 'USD' }, lineas: [1, 2] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPayload({ lineas: [1, 2], total: { moneda: 'USD', monto: '10.00' } })).toBe(h);
    expect(hashPayload({ total: { monto: '10.01', moneda: 'USD' }, lineas: [1, 2] })).not.toBe(h);
    expect(hashPayload({ total: { monto: '10.00', moneda: 'USD' }, lineas: [2, 1] })).not.toBe(h);
  });
});

describe('tokens', () => {
  it('emitirToken da tokens distintos con prefijo cft_ y largo suficiente', () => {
    const a = emitirToken();
    const b = emitirToken();
    expect(a).toMatch(/^cft_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it('tokenCoincide compara por valor, también con largos distintos y vacíos', () => {
    const t = emitirToken();
    expect(tokenCoincide(t, t)).toBe(true);
    expect(tokenCoincide(t, `${t}x`)).toBe(false);
    expect(tokenCoincide(t, t.slice(0, -1))).toBe(false);
    expect(tokenCoincide(t, '')).toBe(false);
    expect(tokenCoincide('', '')).toBe(true);
  });
});

describe('claveIdempotencia', () => {
  it('es determinista por tenant, usuario y propuesta', () => {
    const k = claveIdempotencia(CTX, 'prop_1');
    expect(k).toMatch(/^idk_[0-9a-f]{32}$/);
    const otroRol: ContextoSesion = { ...CTX, rol: 'gerente' };
    expect(claveIdempotencia(otroRol, 'prop_1')).toBe(k); // el rol no entra
    expect(claveIdempotencia(CTX, 'prop_2')).not.toBe(k);
    expect(claveIdempotencia({ ...CTX, usuario: 'beto' }, 'prop_1')).not.toBe(k);
    expect(claveIdempotencia({ ...CTX, tenant: 't2' }, 'prop_1')).not.toBe(k);
  });
});

describe('hashEntrada', () => {
  it('no depende de secretos, de la clave de idempotencia ni del contexto', () => {
    const base = { proposal_id: 'p1', autorizacion: { usuario: 's', pin: '1111', motivo: 'm' } };
    const h = hashEntrada(base);
    expect(hashEntrada({ ...base, autorizacion: { usuario: 's', pin: '9999', motivo: 'm' } })).toBe(h);
    expect(hashEntrada({ ...base, confirmation_token: 'cft_x', idempotency_key: 'idk_x', contexto: CTX })).toBe(h);
    expect(hashEntrada({ ...base, autorizacion: { usuario: 's', pin: '1111', motivo: 'otro' } })).not.toBe(h);
    expect(hashEntrada({ ...base, proposal_id: 'p2' })).not.toBe(h);
  });
});

describe('RegistroIdempotencia', () => {
  it('nueva, repetida y en conflicto', async () => {
    const reg = new RegistroIdempotenciaMemoria();
    const entrada = { proposal_id: 'p1', confirmation_token: 'cft_a' };
    expect(await consultarIdempotencia(reg, CTX, 'idk_12345678', entrada)).toEqual({ estado: 'nueva' });
    await registrarIdempotencia(reg, CTX, 'idk_12345678', entrada, { estado: 'confirmado', resultado: { id: 'x' } });
    expect(await consultarIdempotencia(reg, CTX, 'idk_12345678', { ...entrada, confirmation_token: 'cft_otro' })).toEqual({ estado: 'repetida', resultado: { estado: 'confirmado', resultado: { id: 'x' } } });
    expect(await consultarIdempotencia(reg, CTX, 'idk_12345678', { proposal_id: 'p2' })).toEqual({ estado: 'conflicto' });
  });

  it('aísla por tenant y no comparte referencias con lo guardado', async () => {
    const reg = new RegistroIdempotenciaMemoria();
    const resultado = { n: 1 };
    await registrarIdempotencia(reg, CTX, 'idk_12345678', {}, resultado);
    resultado.n = 99;
    const guardado = await reg.obtener(CTX, 'idk_12345678');
    expect(guardado?.resultado).toEqual({ n: 1 });
    if (guardado) guardado.resultado['n'] = 5;
    expect((await reg.obtener(CTX, 'idk_12345678'))?.resultado).toEqual({ n: 1 });
    expect(await reg.obtener({ tenant: 't2' }, 'idk_12345678')).toBeUndefined();
  });
});
