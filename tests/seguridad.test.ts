import { llamada, ScriptedProvider, ultimoResultadoDeLectura, type PasoGuion } from '@agentic-erp/llm';
import { describe, expect, it } from 'vitest';
import { PIN_SUPERVISOR_DE_PRUEBA, contextoDe, crearDespliegue, HOY } from '../examples/erp-sintetico/src/index.js';

type Obj = Record<string, unknown>;

const final = (extra: Obj = {}): PasoGuion => (req) => {
  const r = ultimoResultadoDeLectura(req);
  return llamada('render_ui', { component: 'ConfirmationCard', proposal_id: r?.['proposal_id'], ...extra });
};

/** Propone un egreso de 800 (pide step-up) y devuelve todo lo que importa para auditar. */
async function escenario(finalDelModelo: PasoGuion) {
  const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Pago de flete', importe: '800' }), finalDelModelo]);
  const d = await crearDespliegue({ llm });
  const s = d.orquestador.crearSesion(contextoDe('operador'));
  const sobres = await s.texto('sacá 800 de la caja para pagarle a un flete');
  const tarjeta = sobres.find((x) => x['component'] === 'ConfirmationCard')!;
  return { llm, d, s, sobres, tarjeta, data: tarjeta['data'] as Obj };
}

describe('seguridad: el modelo nunca ve el token ni el PIN', () => {
  it('ni el token, ni su nombre de campo, ni el PIN aparecen en nada de lo que se le mandó al modelo', async () => {
    const { llm, d, s, tarjeta, data } = await escenario(final());
    try {
      const token = String(data['confirmation_token']);
      expect(token.length).toBeGreaterThan(16);
      await s.manejar({ v: '1.0', type: 'ui.action', message_id: 'm1', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'], confirmation: { confirmation_token: token, step_up: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } } });

      const visto = JSON.stringify([llm.llamadas.map((l) => ({ messages: l.messages, tools: l.tools, system: l.system })), llm.entradasSerializadas()]);
      expect(visto).not.toContain(token);
      expect(visto).not.toContain('confirmation_token');
      expect(visto).not.toContain(PIN_SUPERVISOR_DE_PRUEBA);
      expect(visto).not.toMatch(/"?autorizacion"?\s*:/);
      expect(visto).not.toContain('idempotency_key');
      // lo que sí ve: el id de la propuesta y datos de negocio
      expect(visto).toContain(String(data['proposal_id']));
    } finally {
      await d.cerrar();
    }
  });

  it('ni el token ni el PIN quedan en las trazas', async () => {
    const { d, s, tarjeta, data } = await escenario(final());
    try {
      const token = String(data['confirmation_token']);
      await s.manejar({ v: '1.0', type: 'ui.action', message_id: 'm1', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'], confirmation: { confirmation_token: token, step_up: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } } });
      const traza = JSON.stringify(d.trace.eventos);
      expect(traza).not.toContain(token);
      expect(traza).not.toContain(PIN_SUPERVISOR_DE_PRUEBA);
      expect(traza).toContain('confirmacion_aplicada');
    } finally {
      await d.cerrar();
    }
  });

  it('step-up con motivo: el PIN y el motivo van de la pantalla al servidor; el modelo no ve ninguno y la traza guarda el motivo pero no el PIN', async () => {
    const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Equipos nuevos', importe: '2500' }), final()]);
    const d = await crearDespliegue({ llm });
    try {
      const s = d.orquestador.crearSesion(contextoDe('operador'));
      const sobres = await s.texto('sacá 2500 de la caja por unos equipos nuevos');
      const tarjeta = sobres.find((x) => x['component'] === 'ConfirmationCard')!;
      const data = tarjeta['data'] as Obj;
      expect(data['step_up']).toBe('supervisor_y_motivo');
      const motivo = 'Reposición urgente del salón';
      const r = await s.manejar({ v: '1.1', type: 'ui.action', message_id: 'm1', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'], confirmation: { confirmation_token: data['confirmation_token'], step_up: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA, motivo } } });
      expect(JSON.stringify(r)).toContain('registrado');

      const visto = llm.entradasSerializadas();
      expect(visto).not.toContain(PIN_SUPERVISOR_DE_PRUEBA);
      expect(visto).not.toContain(motivo);
      const traza = JSON.stringify(d.trace.eventos);
      expect(traza).not.toContain(PIN_SUPERVISOR_DE_PRUEBA);
      expect(traza).toContain(motivo);
      expect(d.erp.auditoria.find((a) => a.tool === 'confirmar_movimiento_caja')?.motivo).toBe(motivo);
    } finally {
      await d.cerrar();
    }
  });

  it('el modelo no puede confirmar: ni existe la tool en su catálogo ni se ejecuta si la inventa', async () => {
    const llm = new ScriptedProvider([
      llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Limpieza', importe: '85' }),
      (req) => llamada('confirmar_movimiento_caja', { proposal_id: ultimoResultadoDeLectura(req)?.['proposal_id'], confirmation_token: 'adivinado', idempotency_key: 'idk_x' }),
      final(),
    ]);
    const d = await crearDespliegue({ llm });
    try {
      const sobres = await d.orquestador.crearSesion(contextoDe('operador')).texto('registrá un egreso de caja de 85 por limpieza');
      for (const l of llm.llamadas) expect(l.tools.map((t) => t.name).some((n) => n.startsWith('confirmar_'))).toBe(false);
      expect(d.erp.listarMovimientosCaja(HOY).filas.some((f) => f['concepto'] === 'Limpieza')).toBe(false);
      expect(sobres.some((x) => x['component'] === 'ConfirmationCard')).toBe(true);
    } finally {
      await d.cerrar();
    }
  });
});

describe('seguridad: los montos los pone el servidor', () => {
  it('lo que el modelo escribe en data y speech no cambia el importe que ve la persona', async () => {
    const mentiroso = final({ data: { total: { monto: '1.00', moneda: 'USD' }, titulo: 'Egreso de 1' }, speech: 'Son 1 dólar.' });
    const { d, tarjeta, data, sobres } = await escenario(mentiroso);
    try {
      expect(data['total']).toEqual({ monto: '800.00', moneda: 'USD' });
      expect(String(data['titulo'])).toContain('Pago de flete');
      expect(JSON.stringify(tarjeta['speech'] ?? '')).not.toContain('1 dólar');
      expect(JSON.stringify(sobres)).not.toContain('Egreso de 1"');
    } finally {
      await d.cerrar();
    }
  });

  it('el importe que se aplica al confirmar es el de la propuesta, no uno que mande la superficie', async () => {
    const { d, s, tarjeta, data } = await escenario(final());
    try {
      await s.manejar({ v: '1.0', type: 'ui.action', message_id: 'm1', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'], importe: '1', confirmation: { confirmation_token: data['confirmation_token'], step_up: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } } }).catch(() => undefined);
      const mov = d.erp.listarMovimientosCaja(HOY).filas.filter((f) => f['concepto'] === 'Pago de flete');
      expect(mov.length).toBeLessThanOrEqual(1);
      for (const m of mov) expect(JSON.stringify(m)).toContain('800');
    } finally {
      await d.cerrar();
    }
  });

  it('la persona no puede confirmar con el token de otra propuesta', async () => {
    const { d, s, tarjeta, data } = await escenario(final());
    try {
      const r = await s.manejar({ v: '1.0', type: 'ui.action', message_id: 'm1', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'], confirmation: { confirmation_token: 'cft_de_otra_propuesta_000000', step_up: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } } });
      expect(JSON.stringify(r)).toContain('no es válida');
      expect(d.erp.listarMovimientosCaja(HOY).filas.some((f) => f['concepto'] === 'Pago de flete')).toBe(false);
    } finally {
      await d.cerrar();
    }
  });
});

describe('seguridad: modo directo (comando en user.input)', () => {
  const comando = (tool: string, args: Obj = {}, extra: Obj = {}): Obj => ({ v: '1.1', type: 'user.input', message_id: `m_${tool}`, text: `[directo] ${tool}`, comando: { tool, args }, ...extra });

  it('un comando con confirmar_* se rechaza con report_error (ErrorNotice) y no ejecuta nada en el ERP', async () => {
    const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Limpieza', importe: '85' }), final()]);
    const d = await crearDespliegue({ llm });
    try {
      const s = d.orquestador.crearSesion(contextoDe('operador'));
      const sobres = await s.texto('registrá un egreso de caja de 85 por limpieza');
      const data = sobres.find((x) => x['component'] === 'ConfirmationCard')!['data'] as Obj;
      // Con el token real de la propuesta y todo: igual se rechaza, porque confirmar solo lo hace el Confirmador.
      const r = await s.manejar(comando('confirmar_movimiento_caja', { proposal_id: data['proposal_id'], confirmation_token: data['confirmation_token'], idempotency_key: 'idk_directo_01' }));
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ component: 'ErrorNotice', data: { codigo: 'COMANDO_NO_PERMITIDO' } });
      expect(d.erp.listarMovimientosCaja(HOY).filas.some((f) => f['concepto'] === 'Limpieza')).toBe(false);
      expect(d.trace.eventos.some((e) => e.evento === 'comando_rechazado')).toBe(true);
      expect(d.trace.eventos.filter((e) => e.evento === 'confirmacion_enviada')).toHaveLength(0);
    } finally {
      await d.cerrar();
    }
  });

  it('un preparar_* por comando no ejecuta nada sin confirmación; y solo la persona lo confirma, con la misma tarjeta', async () => {
    const llm = new ScriptedProvider([]);
    const d = await crearDespliegue({ llm });
    try {
      const s = d.orquestador.crearSesion(contextoDe('operador'));
      const sobres = await s.manejar(comando('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Pago de flete', importe: '800' }));
      expect(llm.llamadas).toHaveLength(0);
      const tarjeta = sobres.find((x) => x['component'] === 'ConfirmationCard')!;
      const data = tarjeta['data'] as Obj;
      expect(data['total']).toEqual({ monto: '800.00', moneda: 'USD' });
      expect(d.erp.listarMovimientosCaja(HOY).filas.some((f) => f['concepto'] === 'Pago de flete')).toBe(false);
      expect(d.erp.auditoria.some((a) => a.tool === 'confirmar_movimiento_caja')).toBe(false);

      // El token no se filtra a la traza y la persona confirma por el camino normal.
      const r = await s.manejar({ v: '1.0', type: 'ui.action', message_id: 'm2', intent_id: tarjeta['intent_id'], action_id: 'confirmar', proposal_id: data['proposal_id'], confirmation: { confirmation_token: data['confirmation_token'], step_up: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } } });
      expect(JSON.stringify(r)).toContain('registrado');
      expect(d.erp.listarMovimientosCaja(HOY).filas.filter((f) => f['concepto'] === 'Pago de flete')).toHaveLength(1);
      expect(JSON.stringify(d.trace.eventos)).not.toContain(String(data['confirmation_token']));
    } finally {
      await d.cerrar();
    }
  });

  it('el comando respeta los permisos del rol: un rol sin permiso no prepara', async () => {
    const d = await crearDespliegue({ llm: new ScriptedProvider([]) });
    try {
      const r = await d.orquestador.crearSesion(contextoDe('lectura')).manejar(comando('preparar_orden_compra', { proveedor_id: 'prv_01', items: [{ articulo_id: 'art_001', cantidad: 4 }] }));
      expect(r[0]).toMatchObject({ component: 'ErrorNotice', data: { codigo: 'PERMISO_DENEGADO' } });
    } finally {
      await d.cerrar();
    }
  });
});
