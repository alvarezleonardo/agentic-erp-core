import { llamada, ScriptedProvider, ultimoResultadoDeLectura, type PasoGuion } from '@agentic-erp/llm';
import { verificarConformidad } from '@agentic-erp/mcp-contract';
import { describe, expect, it } from 'vitest';
import { REGISTRO_AGENTES, crearDespliegue, contextoDe, crearServidorMcp, toolsMcp, ErpSintetico, PIN_SUPERVISOR_DE_PRUEBA, HOY } from '../src/index.js';

type Obj = Record<string, unknown>;
const ctx = (rol: string) => contextoDe(rol);

const finalConFuente = (component: string): PasoGuion => (req) => {
  const r = ultimoResultadoDeLectura(req);
  return llamada('render_ui', { component, proposal_id: r?.['proposal_id'] ?? r?.['source_id'] });
};

describe('el servidor MCP del ejemplo cumple el contrato', () => {
  it('pasa la verificación de conformidad y tiene un catálogo acotado', () => {
    const r = verificarConformidad(toolsMcp());
    expect(r.hallazgos.filter((h) => h.nivel === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(toolsMcp().length).toBeGreaterThan(15);
  });

  it('cada agente tiene como máximo 15 tools, ninguna confirmar_*, y todas existen en el servidor', () => {
    const nombres = toolsMcp().map((t) => t.nombre);
    for (const a of REGISTRO_AGENTES.todos()) {
      expect(a.tools.length).toBeLessThanOrEqual(15);
      expect(a.tools.some((t) => t.startsWith('confirmar_'))).toBe(false);
      expect(a.systemPrompt).toContain('REGLAS DURAS');
    }
    expect(REGISTRO_AGENTES.validarContraCatalogo(nombres)).toEqual([]);
  });
});

describe('datos sintéticos', () => {
  it('son deterministas: dos instancias dan lo mismo', () => {
    const a = new ErpSintetico();
    const b = new ErpSintetico();
    expect(a.consultarMetrica(['ventas_total'], '2026-03-01', HOY, false)).toEqual(b.consultarMetrica(['ventas_total'], '2026-03-01', HOY, false));
  });

  it('el detector encuentra las dos anomalías sembradas', () => {
    const erp = new ErpSintetico();
    const { anomalias } = erp.detectarAnomalias('2026-03-01', HOY);
    const fechas = anomalias.map((x) => x.fecha);
    expect(fechas).toEqual(expect.arrayContaining(['2026-03-24', '2026-03-28']));
  });
});

describe('proponer y confirmar sobre el ERP real (en memoria)', () => {
  it('un egreso chico: el modelo propone, la persona confirma, el servidor aplica y repetir no duplica', async () => {
    const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Limpieza', importe: '85' }), finalConFuente('ConfirmationCard')]);
    const d = await crearDespliegue({ llm });
    try {
      const s = d.orquestador.crearSesion(ctx('operador'));
      const sobres = await s.texto('registrá un egreso de caja de 85 por limpieza');
      const tarjeta = sobres.find((x) => x['component'] === 'ConfirmationCard')!;
      const data = tarjeta['data'] as Obj;
      expect(data['total']).toEqual({ monto: '85.00', moneda: 'USD' });
      const accion = (tarjeta['actions'] as Obj[]).find((a) => a['id'] === 'confirmar')!;
      expect(accion['step_up']).toBeUndefined();

      const saldoAntes = (d.erp.estadoCaja(HOY).campos as { etiqueta: string; valor: string }[]).map((c) => c.valor).join('|');
      const msg = { v: '1.0', type: 'ui.action', message_id: 'm1', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'], confirmation: { confirmation_token: data['confirmation_token'], idempotency_key: 'idk_doble_toque_1' } };
      const r1 = await s.manejar(msg);
      const r2 = await s.manejar(msg);
      expect(JSON.stringify(r1)).toContain('registrado');
      expect(JSON.stringify(r2)).toBeTruthy();
      const saldoDespues = (d.erp.estadoCaja(HOY).campos as { etiqueta: string; valor: string }[]).map((c) => c.valor).join('|');
      expect(saldoDespues).not.toBe(saldoAntes);
      const movs = d.erp.listarMovimientosCaja(HOY).filas.filter((f) => f['concepto'] === 'Limpieza');
      expect(movs).toHaveLength(1);
    } finally {
      await d.cerrar();
    }
  });

  it('un egreso grande exige un supervisor: sin PIN no pasa, con PIN incorrecto tampoco, con el correcto sí', async () => {
    const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Pago de flete', importe: '800' }), finalConFuente('ConfirmationCard')]);
    const d = await crearDespliegue({ llm });
    try {
      const s = d.orquestador.crearSesion(ctx('operador'));
      const sobres = await s.texto('sacá 800 de la caja para pagarle a un flete');
      const tarjeta = sobres.find((x) => x['component'] === 'ConfirmationCard')!;
      const data = tarjeta['data'] as Obj;
      expect(((tarjeta['actions'] as Obj[]).find((a) => a['id'] === 'confirmar') as Obj)['step_up']).toBe('supervisor');
      const base = { v: '1.0', type: 'ui.action', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'] };
      const sin = await s.manejar({ ...base, message_id: 'm1', confirmation: { confirmation_token: data['confirmation_token'] } });
      expect(JSON.stringify(sin)).toContain('necesita la autorización');
      const mal = await s.manejar({ ...base, message_id: 'm2', confirmation: { confirmation_token: data['confirmation_token'], step_up: { usuario: 'supervisor1', pin: '0000' } } });
      expect(JSON.stringify(mal)).toContain('incorrectos');
      const bien = await s.manejar({ ...base, message_id: 'm3', confirmation: { confirmation_token: data['confirmation_token'], step_up: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } } });
      expect(JSON.stringify(bien)).toContain('registrado');
      expect(d.erp.listarMovimientosCaja(HOY).filas.filter((f) => f['concepto'] === 'Pago de flete')).toHaveLength(1);
    } finally {
      await d.cerrar();
    }
  });

  it('un egreso muy grande exige supervisor y motivo: la tarjeta lo declara y el servidor no confirma sin las dos cosas', async () => {
    const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Compra de equipos', importe: '2500' }), finalConFuente('ConfirmationCard')]);
    const d = await crearDespliegue({ llm });
    try {
      const s = d.orquestador.crearSesion(ctx('operador'));
      const sobres = await s.texto('sacá 2500 de la caja por unos equipos nuevos');
      const tarjeta = sobres.find((x) => x['component'] === 'ConfirmationCard')!;
      const data = tarjeta['data'] as Obj;
      expect(data['step_up']).toBe('supervisor_y_motivo');
      expect(((tarjeta['actions'] as Obj[]).find((a) => a['id'] === 'confirmar') as Obj)['step_up']).toBe('supervisor_y_motivo');
      expect(d.orquestador.validador.validarSobre(tarjeta).ok).toBe(true);
      const base = { v: '1.1', type: 'ui.action', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'] };
      const token = data['confirmation_token'];
      const aplicar = (n: number, step_up?: Obj): Promise<unknown[]> => s.manejar({ ...base, message_id: `m${n}`, confirmation: { confirmation_token: token, ...(step_up ? { step_up } : {}) } });
      const registrado = (): number => d.erp.listarMovimientosCaja(HOY).filas.filter((f) => f['concepto'] === 'Compra de equipos').length;

      expect(JSON.stringify(await aplicar(1))).toContain('responsable y un motivo');
      expect(JSON.stringify(await aplicar(2, { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA }))).toContain('motivo');
      expect(JSON.stringify(await aplicar(3, { motivo: 'Reposición urgente' }))).toContain('responsable');
      expect(JSON.stringify(await aplicar(4, { usuario: 'supervisor1', pin: '0000', motivo: 'Reposición urgente' }))).toContain('incorrectos');
      expect(registrado()).toBe(0);
      expect(JSON.stringify(await aplicar(5, { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA, motivo: 'Reposición urgente' }))).toContain('registrado');
      expect(registrado()).toBe(1);
      expect(d.erp.auditoria.find((a) => a.tool === 'confirmar_movimiento_caja')).toMatchObject({ autorizo: 'supervisor1', motivo: 'Reposición urgente', origen: 'humano' });
    } finally {
      await d.cerrar();
    }
  });

  it('un ingreso grande pide solo un motivo (sin supervisor) y nadie se autoriza a sí mismo', async () => {
    const erp = new ErpSintetico({ autorizadores: { supervisor1: { pin: PIN_SUPERVISOR_DE_PRUEBA, rol: 'supervisor' } } });
    const ing = erp.prepararMovimientoCaja({ tipo: 'ingreso', concepto: 'Aporte de socio', importe: '900' }, ctx('operador'));
    expect(ing.step_up).toBe('motivo');
    expect(ing.requiere_step_up).toBeUndefined(); // un motivo no es la autorización de otra persona
    const args = (p: { proposal_id: string; confirmation_token: string }, extra: Obj = {}): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: `idk_${p.proposal_id}_01`, ...extra });
    await expect(erp.confirmar('movimiento_caja', args(ing), ctx('operador'))).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    await expect(erp.confirmar('movimiento_caja', args(ing, { autorizacion: { motivo: 'ab' } }), ctx('operador'))).rejects.toMatchObject({ codigo: 'PARAMETRO_INVALIDO' });
    await expect(erp.confirmar('movimiento_caja', args(ing, { autorizacion: { motivo: 'Aporte de capital' } }), ctx('operador'))).resolves.toMatchObject({ estado: 'confirmado' });

    const egr = erp.prepararMovimientoCaja({ tipo: 'egreso', concepto: 'Pago de flete', importe: '800' }, contextoDe('supervisor', 'supervisor1'));
    const propio = { autorizacion: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } };
    await expect(erp.confirmar('movimiento_caja', args(egr, propio), contextoDe('supervisor', 'supervisor1'))).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
  });

  it('confirmar usa el kit de idempotencia: misma clave repite sin duplicar, otra clave o otra entrada se rechaza, y un PIN incorrecto no consume la clave', async () => {
    const erp = new ErpSintetico({ autorizadores: { supervisor1: { pin: PIN_SUPERVISOR_DE_PRUEBA, rol: 'supervisor' } } });
    const op = contextoDe('operador');
    const p = erp.prepararMovimientoCaja({ tipo: 'egreso', concepto: 'Pago de flete', importe: '800' }, op);
    const args = (extra: Obj = {}, clave = 'idk_kit_0001'): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: clave, ...extra });
    const bien = { autorizacion: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } };

    await expect(erp.confirmar('movimiento_caja', args({ autorizacion: { usuario: 'supervisor1', pin: '0000' } }), op)).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
    const primera = await erp.confirmar('movimiento_caja', args(bien), op);
    expect(primera.idempotente).toBe(false);
    const repetida = await erp.confirmar('movimiento_caja', args(bien), op);
    expect(repetida).toMatchObject({ idempotente: true, resultado: primera.resultado });
    expect(erp.listarMovimientosCaja(HOY).filas.filter((f) => f['concepto'] === 'Pago de flete')).toHaveLength(1);
    // el PIN no entra al hash: repetir con otro PIN sigue siendo la misma entrada
    expect(await erp.confirmar('movimiento_caja', args({ autorizacion: { usuario: 'supervisor1', pin: 'otro' } }), op)).toMatchObject({ idempotente: true });
    await expect(erp.confirmar('movimiento_caja', args({ autorizacion: { usuario: 'otro_usuario', pin: '1' } }), op)).rejects.toMatchObject({ codigo: 'PARAMETRO_INVALIDO' });
    await expect(erp.confirmar('movimiento_caja', args(bien, 'idk_kit_0002'), op)).rejects.toMatchObject({ codigo: 'PROPUESTA_YA_CONFIRMADA' });
  });

  it('el rol sin permiso no puede preparar: el servidor es la autoridad aunque se salte al orquestador', async () => {
    const erp = new ErpSintetico();
    expect(() => erp.prepararOrdenCompra({ proveedor_id: 'prv_01', items: [{ articulo_id: 'art_001', cantidad: 4 }] }, ctx('operador'))).toThrow(/rol/i);
    expect(() => erp.prepararOrdenCompra({ proveedor_id: 'prv_01', items: [{ articulo_id: 'art_001', cantidad: 4 }] }, ctx('supervisor'))).not.toThrow();
  });

  it('solo quien preparó la propuesta puede confirmarla', async () => {
    const erp = new ErpSintetico();
    const p = erp.prepararMovimientoCaja({ tipo: 'ingreso', concepto: 'Aporte', importe: '10' }, ctx('operador'));
    await expect(erp.confirmar('movimiento_caja', { proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: 'idk_x' }, contextoDe('operador', 'otro'))).rejects.toThrow(/preparó/);
  });

  it('el cliente MCP en memoria expone el mismo catálogo que el servidor', async () => {
    const { servidor } = crearServidorMcp();
    const { ClienteMcp } = await import('@agentic-erp/mcp-client');
    const c = await ClienteMcp.enMemoria(servidor);
    try {
      const tools = await c.listarTools();
      expect(tools.map((t) => t.nombre).sort()).toEqual(toolsMcp().map((t) => t.nombre).sort());
    } finally {
      await c.cerrar();
    }
  });
});
