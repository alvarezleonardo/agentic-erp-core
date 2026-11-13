import { describe, expect, it } from 'vitest';
import {
  CAMPOS_RESERVADOS,
  centavosDeDinero,
  confirmarDe,
  dineroDeCentavos,
  esLectura,
  esquemaParaModelo,
  faltanteDeStepUp,
  multiplicar,
  normalizarStepUp,
  pideMotivo,
  pideSupervisor,
  stepUpDe,
  schemaDelContrato,
  validarContrato,
  verificarConformidad,
  type ToolMcp,
} from '../src/index.js';

const CONTEXTO = { type: 'object' };
const tool = (nombre: string, props: Record<string, unknown> = {}, required: string[] = ['contexto']): ToolMcp => ({
  nombre,
  descripcion: `descripción de ${nombre}`,
  esquema: { type: 'object', properties: { contexto: CONTEXTO, ...props }, required },
});

const catalogoMinimo = (): ToolMcp[] => [tool('listar_metricas'), tool('consultar_metrica'), tool('consumir_eventos')];

describe('dinero', () => {
  it('convierte centavos a string con dos decimales y de vuelta', () => {
    expect(dineroDeCentavos(123_456, 'USD')).toEqual({ monto: '1234.56', moneda: 'USD' });
    expect(dineroDeCentavos(5)).toEqual({ monto: '0.05', moneda: 'USD' });
    expect(dineroDeCentavos(-1_050).monto).toBe('-10.50');
    expect(centavosDeDinero({ monto: '-10.50', moneda: 'USD' })).toBe(-1_050);
  });

  it('multiplica cantidad decimal por precio sin floats y redondea al centavo', () => {
    expect(multiplicar(4_700, '18')).toBe(84_600);
    expect(multiplicar(1_000, '0.333')).toBe(333);
    expect(multiplicar(1_001, '0.5')).toBe(501);
  });

  it('rechaza montos y cantidades mal formados', () => {
    expect(() => centavosDeDinero({ monto: '12', moneda: 'USD' })).toThrow();
    expect(() => multiplicar(100, '1,5')).toThrow();
    expect(() => dineroDeCentavos(1.5)).toThrow();
  });
});

describe('esquemas del contrato', () => {
  it('valida una propuesta correcta y rechaza una sin token', () => {
    const ok = { proposal_id: 'p1', confirmation_token: 'cft_0123456789abcdef', expira_en: '2026-03-31T12:10:00.000Z', titulo: 'Orden', total: { monto: '10.00', moneda: 'USD' } };
    expect(validarContrato('Propuesta', ok).ok).toBe(true);
    const { confirmation_token: _omitido, ...sinToken } = ok;
    const r = validarContrato('Propuesta', sinToken);
    expect(r.ok).toBe(false);
    expect(r.errores.join(' ')).toContain('confirmation_token');
  });

  it('exige idempotency_key en la confirmación y rechaza montos que no son strings con dos decimales', () => {
    const base = { contexto: { tenant: 't', usuario: 'u', rol: 'r' }, proposal_id: 'p1', confirmation_token: 'cft_0123456789abcdef' };
    expect(validarContrato('ConfirmarEntrada', base).ok).toBe(false);
    expect(validarContrato('ConfirmarEntrada', { ...base, idempotency_key: 'idk_12345678' }).ok).toBe(true);
    expect(validarContrato('Dinero', { monto: 10, moneda: 'USD' }).ok).toBe(false);
    expect(validarContrato('Dinero', { monto: '10.5', moneda: 'USD' }).ok).toBe(false);
  });

  it('valida eventos con cursor y métricas', () => {
    expect(validarContrato('Evento', { secuencia: 1, tipo: 'orden_creada', ocurrido_en: '2026-03-31T10:00:00Z', payload: {} }).ok).toBe(true);
    expect(validarContrato('Evento', { secuencia: 0, tipo: 'OrdenCreada', ocurrido_en: 'ayer', payload: {} }).ok).toBe(false);
    const metrica = { id: 'ventas_total', etiqueta: 'Ventas', descripcion: 'x', tipo: 'moneda', dimensiones: ['dia'], sentido_favorable: 'mayor_es_mejor' };
    expect(validarContrato('DefMetrica', metrica).ok).toBe(true);
    expect(validarContrato('DefMetrica', { ...metrica, tipo: 'texto' }).ok).toBe(false);
  });

  it('el JSON Schema declara exactamente las definiciones que expone validarContrato', () => {
    const defs = Object.keys((schemaDelContrato()['$defs'] ?? {}) as object).filter((d) => d !== 'Valor').sort();
    for (const d of defs) expect(() => validarContrato(d as never, {})).not.toThrow();
    expect(defs).toContain('Propuesta');
    expect(defs).toContain('ConsumirEventosSalida');
  });
});

describe('convenciones de nombres y esquemas', () => {
  it('relaciona preparar y confirmar y reconoce lecturas', () => {
    expect(confirmarDe('preparar_orden_compra')).toBe('confirmar_orden_compra');
    expect(esLectura('listar_stock')).toBe(true);
    expect(esLectura('preparar_orden_compra')).toBe(false);
  });

  it('esquemaParaModelo quita los campos que inyecta el orquestador sin mutar el original', () => {
    const original = { type: 'object', properties: { contexto: {}, idempotency_key: {}, texto: {} }, required: ['contexto', 'idempotency_key', 'texto'] };
    const visto = esquemaParaModelo(original) as { properties: Record<string, unknown>; required: string[] };
    for (const c of CAMPOS_RESERVADOS) expect(visto.properties).not.toHaveProperty(c);
    expect(visto.required).toEqual(['texto']);
    expect(original.required).toHaveLength(3);
  });
});

describe('verificarConformidad: capacidades opt-in', () => {
  it('sin capacidades declaradas exige todas (compatibilidad)', () => {
    const r = verificarConformidad([tool('listar_cosas')]);
    expect(r.ok).toBe(false);
    expect(r.hallazgos.map((h) => h.mensaje).join('\n')).toMatch(/listar_metricas[\s\S]*consultar_metrica[\s\S]*consumir_eventos/);
  });

  it('capacidades vacías: no exige métricas ni eventos', () => {
    expect(verificarConformidad([tool('listar_cosas')], { capacidades: [] }).ok).toBe(true);
  });

  it('metricas exige listar_metricas y consultar_metrica, pero no consumir_eventos', () => {
    const r = verificarConformidad([tool('listar_metricas')], { capacidades: ['metricas'] });
    expect(r.hallazgos.some((h) => h.mensaje.includes('consultar_metrica'))).toBe(true);
    expect(r.hallazgos.some((h) => h.mensaje.includes('consumir_eventos'))).toBe(false);
    expect(verificarConformidad([tool('listar_metricas'), tool('consultar_metrica')], { capacidades: ['metricas'] }).ok).toBe(true);
  });

  it('eventos exige solo consumir_eventos', () => {
    expect(verificarConformidad([tool('consumir_eventos')], { capacidades: ['eventos'] }).ok).toBe(true);
    expect(verificarConformidad([tool('listar_cosas')], { capacidades: ['eventos'] }).ok).toBe(false);
  });
});

describe('verificarConformidad', () => {
  it('acepta un catálogo mínimo con las tools obligatorias', () => {
    expect(verificarConformidad(catalogoMinimo()).ok).toBe(true);
  });

  it('marca las tools obligatorias que faltan', () => {
    const r = verificarConformidad([tool('listar_metricas')]);
    expect(r.ok).toBe(false);
    expect(r.hallazgos.map((h) => h.mensaje).join('\n')).toContain('consumir_eventos');
  });

  it('exige el par preparar/confirmar completo y con la forma de confirmación', () => {
    const solo = verificarConformidad([...catalogoMinimo(), tool('preparar_orden')]);
    expect(solo.hallazgos.some((h) => h.nivel === 'error' && h.mensaje.includes('confirmar_orden'))).toBe(true);

    const confirmarMal = tool('confirmar_orden', { proposal_id: {} }, ['contexto', 'proposal_id']);
    const r = verificarConformidad([...catalogoMinimo(), tool('preparar_orden'), confirmarMal]);
    const faltan = r.hallazgos.filter((h) => h.tool === 'confirmar_orden').map((h) => h.mensaje);
    expect(faltan.some((m) => m.includes('confirmation_token'))).toBe(true);
    expect(faltan.some((m) => m.includes('idempotency_key'))).toBe(true);

    const completo = tool('confirmar_orden', { proposal_id: {}, confirmation_token: {}, idempotency_key: {} }, ['contexto', 'proposal_id', 'confirmation_token', 'idempotency_key']);
    expect(verificarConformidad([...catalogoMinimo(), tool('preparar_orden'), completo]).ok).toBe(true);
  });

  it('exige contexto en todas las tools y prohíbe secretos fuera de confirmar_*', () => {
    const sinContexto: ToolMcp = { nombre: 'listar_cosas', descripcion: 'x', esquema: { type: 'object', properties: {}, required: [] } };
    expect(verificarConformidad([...catalogoMinimo(), sinContexto]).ok).toBe(false);
    const conPin = tool('listar_usuarios', { pin: {} });
    expect(verificarConformidad([...catalogoMinimo(), conPin]).hallazgos.some((h) => h.mensaje.includes('secreto'))).toBe(true);
    expect(verificarConformidad([...catalogoMinimo(), tool('listar_pinzas', { pinza: {} })]).ok).toBe(true);
  });

  it('prohíbe que una tool que no es confirmar_* reciba confirmation_token', () => {
    const r = verificarConformidad([...catalogoMinimo(), tool('listar_cosas', { confirmation_token: {} })]);
    expect(r.ok).toBe(false);
  });
});

describe('step-up', () => {
  it('normaliza niveles y acepta autorizacion como alias de supervisor', () => {
    expect(normalizarStepUp('autorizacion')).toBe('supervisor');
    expect(normalizarStepUp(true)).toBe('supervisor');
    expect(normalizarStepUp(false)).toBe('none');
    for (const n of ['none', 'motivo', 'supervisor', 'supervisor_y_motivo']) expect(normalizarStepUp(n)).toBe(n);
    expect(normalizarStepUp('otro')).toBeUndefined();
    expect(normalizarStepUp(undefined)).toBeUndefined();
  });

  it('el nivel de una propuesta sale de step_up y, si falta, de requiere_step_up', () => {
    expect(stepUpDe({})).toBe('none');
    expect(stepUpDe({ requiere_step_up: true })).toBe('supervisor');
    expect(stepUpDe({ step_up: 'motivo' })).toBe('motivo');
    expect(stepUpDe({ step_up: 'supervisor_y_motivo', requiere_step_up: true })).toBe('supervisor_y_motivo');
    expect(stepUpDe({ step_up: 'raro', requiere_step_up: true })).toBe('supervisor');
  });

  it('qué pide cada nivel', () => {
    expect([pideSupervisor('none'), pideSupervisor('motivo'), pideSupervisor('supervisor'), pideSupervisor('supervisor_y_motivo')]).toEqual([false, false, true, true]);
    expect([pideMotivo('none'), pideMotivo('motivo'), pideMotivo('supervisor'), pideMotivo('supervisor_y_motivo')]).toEqual([false, true, false, true]);
  });

  it('faltanteDeStepUp dice qué falta', () => {
    expect(faltanteDeStepUp('none', undefined)).toBeUndefined();
    expect(faltanteDeStepUp('motivo', { motivo: 'algo' })).toBeUndefined();
    expect(faltanteDeStepUp('motivo', { motivo: '  ' })?.accion_sugerida).toMatch(/motivo/);
    expect(faltanteDeStepUp('supervisor', { usuario: 'a', pin: '1' })).toBeUndefined();
    expect(faltanteDeStepUp('supervisor', { usuario: 'a' })?.accion_sugerida).toMatch(/PIN/);
    expect(faltanteDeStepUp('supervisor_y_motivo', { usuario: 'a', pin: '1' })?.accion_sugerida).toMatch(/motivo/);
    expect(faltanteDeStepUp('supervisor_y_motivo', undefined)?.mensaje).toMatch(/responsable y un motivo/);
  });

  it('el schema acepta step_up en la propuesta y motivo en la autorización, y rechaza lo desconocido', () => {
    const propuesta = { proposal_id: 'p1', confirmation_token: 'cft_0123456789abcdef', expira_en: '2026-03-31T12:10:00.000Z', titulo: 'T' };
    expect(validarContrato('Propuesta', { ...propuesta, step_up: 'supervisor_y_motivo', requiere_step_up: true }).ok).toBe(true);
    expect(validarContrato('Propuesta', { ...propuesta, step_up: 'autorizacion' }).ok).toBe(false);
    const entrada = { contexto: { tenant: 't', usuario: 'u', rol: 'r' }, proposal_id: 'p1', confirmation_token: 'cft_0123456789abcdef', idempotency_key: 'idk_12345678' };
    expect(validarContrato('ConfirmarEntrada', { ...entrada, autorizacion: { motivo: 'Cierre' } }).ok).toBe(true);
    expect(validarContrato('ConfirmarEntrada', { ...entrada, autorizacion: { usuario: 's', pin: '1', motivo: 'Cierre' } }).ok).toBe(true);
    expect(validarContrato('ConfirmarEntrada', { ...entrada, autorizacion: { usuario: 's', clave: '1' } }).ok).toBe(false);
  });
});
