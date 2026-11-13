import { describe, expect, it } from 'vitest';
import { ContractValidator } from '../src/index.js';
import { bancoDeCompositor } from './fakes.js';

const propuesta = (extra: Record<string, unknown> = {}) => ({
  proposal_id: 'prop_1',
  confirmation_token: 'cft_secreto_0123456789abcdef',
  expira_en: '2026-03-31T12:10:00.000Z',
  titulo: 'Orden de compra',
  lineas: [{ descripcion: 'Teclado', cantidad: '18', precio_unitario: { monto: '47.00', moneda: 'USD' }, importe: { monto: '846.00', moneda: 'USD' } }],
  total: { monto: '846.00', moneda: 'USD' },
  ...extra,
});

describe('Compositor: los montos los pone el servidor', () => {
  it('hidrata ConfirmationCard desde la propuesta y descarta lo que el modelo escribió en campos x-source', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarPropuesta('preparar_cosa', {}, propuesta(), 'int_a', 'cosas');
    const r = compositor.componer(
      { tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_1', data: { total: { monto: '1.00', moneda: 'USD' }, titulo: 'Gratis', confirmation_token: 'inventado', lineas: [] }, speech: 'Listo, son $ 1,00.' },
      ctxComp,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.sobre['data'] as Record<string, unknown>;
    expect(data['total']).toEqual({ monto: '846.00', moneda: 'USD' });
    expect(data['titulo']).toBe('Orden de compra');
    expect(data['confirmation_token']).toBe('cft_secreto_0123456789abcdef');
    expect((data['lineas'] as unknown[]).length).toBe(1);
    expect(r.sobre['speech']).toBeUndefined();
    expect(r.descartes.map((d) => d.motivo)).toEqual(expect.arrayContaining(['x-source', 'speech_con_monto']));
  });

  it('el catálogo decide qué acciones confirman y el modelo solo puede elegir un subconjunto', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarPropuesta('preparar_cosa', {}, propuesta(), 'int_a', 'cosas');
    const r = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_1', actions: [{ id: 'confirmar', label: 'Dale' }, { id: 'borrar_todo' }] }, ctxComp);
    expect(r.ok && r.acciones).toEqual([{ id: 'confirmar', label: 'Dale', kind: 'primary', confirms: true }]);
    expect(r.ok && r.descartes.some((d) => d.motivo === 'accion_fuera_de_catalogo')).toBe(true);
  });

  it('una propuesta que exige autorización lo declara en la acción de confirmar', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarPropuesta('preparar_cosa', {}, propuesta({ requiere_step_up: true }), 'int_a', 'cosas');
    const r = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_1' }, ctxComp);
    expect(r.ok && r.acciones.find((a) => a.id === 'confirmar')?.step_up).toBe('supervisor');
    expect(r.ok && (r.sobre['actions'] as { id: string; step_up?: string }[]).find((a) => a.id === 'confirmar')?.step_up).toBe('supervisor');
  });

  it('la tarjeta declara qué pide la confirmación: step_up en data y en la acción, validado contra los schemas', () => {
    for (const nivel of ['motivo', 'supervisor', 'supervisor_y_motivo']) {
      const { store, compositor, ctxComp, validador } = bancoDeCompositor();
      store.guardarPropuesta('preparar_cosa', {}, propuesta({ step_up: nivel }), 'int_a', 'cosas');
      const r = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_1' }, ctxComp);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.sobre['data'] as Record<string, unknown>)['step_up']).toBe(nivel);
      expect((r.sobre['actions'] as { id: string; step_up?: string }[]).find((a) => a.id === 'confirmar')?.step_up).toBe(nivel);
      expect(validador.validarSobre(r.sobre).ok).toBe(true);
    }
  });

  it('sin step-up la tarjeta no lo declara; el modelo no puede inventarlo en data', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarPropuesta('preparar_cosa', {}, propuesta(), 'int_a', 'cosas');
    const r = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_1', data: { step_up: 'supervisor' } }, ctxComp);
    expect(r.ok && (r.sobre['data'] as Record<string, unknown>)['step_up']).toBeUndefined();
    expect(r.ok && r.descartes.some((d) => d.campo === 'step_up')).toBe(true);
  });

  it('sin proposal_id usa la última fuente compatible de la intención', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarPropuesta('preparar_cosa', {}, propuesta(), 'int_a', 'cosas');
    const r = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard' }, ctxComp);
    expect(r.ok && r.fuenteId).toBe('prop_1');
  });

  it('rechaza una propuesta vencida, una de otra intención o una fuente del tipo equivocado', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarPropuesta('preparar_cosa', {}, propuesta({ expira_en: '2026-03-31T11:00:00.000Z' }), 'int_a', 'cosas');
    expect(compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_1' }, ctxComp)).toMatchObject({ ok: false });
    store.guardarPropuesta('preparar_cosa', {}, propuesta({ proposal_id: 'prop_ajena' }), 'int_b', 'cosas');
    const ajena = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_ajena' }, ctxComp);
    expect(ajena.ok).toBe(false);
    const lectura = store.guardarLectura('leer_tabla', {}, { columnas: [{ id: 'a', etiqueta: 'A' }], filas: [] }, 'int_a', 'cosas');
    const mal = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: lectura.id }, ctxComp);
    expect(mal.ok).toBe(false);
  });
});

describe('Compositor: tablas, permisos de componente y texto libre', () => {
  it('hidrata DataTable y recorta a 200 filas marcando la tabla como truncada', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    const filas = Array.from({ length: 250 }, (_, i) => ({ n: String(i) }));
    const f = store.guardarLectura('leer_tabla', {}, { titulo: 'Grande', columnas: [{ id: 'n', etiqueta: 'N' }], filas, total_filas: 250 }, 'int_a', 'cosas');
    const r = compositor.componer({ tipo: 'render_ui', component: 'DataTable', proposal_id: f.id }, ctxComp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.sobre['data'] as { filas: unknown[]; truncada?: boolean; total_filas: number };
    expect(data.filas).toHaveLength(200);
    expect(data.truncada).toBe(true);
    expect(data.total_filas).toBe(250);
  });

  it('rechaza un componente que el agente no tiene permitido', () => {
    const { compositor, ctxComp } = bancoDeCompositor();
    const r = compositor.componer({ tipo: 'render_ui', component: 'KpiTiles' }, ctxComp);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.errores[0]).toContain('no está permitido');
  });

  it('rechaza textos libres del modelo con importes', () => {
    const { compositor, ctxComp } = bancoDeCompositor();
    expect(compositor.componer({ tipo: 'report_error', codigo: 'X_Y', mensaje: 'Faltan $ 5.000 para cerrar' }, ctxComp).ok).toBe(false);
    const form = compositor.componer({ tipo: 'render_ui', component: 'FormCard', data: { titulo: 'Pagar 1.500,00', campos: [{ id: 'a', etiqueta: 'A', tipo: 'texto' }] } }, ctxComp);
    expect(form.ok).toBe(false);
  });

  it('valida el FormCard contra su schema', () => {
    const { compositor, ctxComp } = bancoDeCompositor();
    const ok = compositor.componer({ tipo: 'render_ui', component: 'FormCard', data: { titulo: 'Motivo', campos: [{ id: 'motivo', etiqueta: 'Motivo', tipo: 'texto', requerido: true }] } }, ctxComp);
    expect(ok.ok).toBe(true);
    const mal = compositor.componer({ tipo: 'render_ui', component: 'FormCard', data: { titulo: 'Motivo', campos: [{ id: 'Motivo raro', etiqueta: 'M', tipo: 'fecha_inventada' }] } }, ctxComp);
    expect(mal.ok).toBe(false);
  });

  it('respeta los componentes que declaró la superficie', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    compositor.soportados = { ConfirmationCard: [2] };
    store.guardarPropuesta('preparar_cosa', {}, propuesta(), 'int_a', 'cosas');
    const r = compositor.componer({ tipo: 'render_ui', component: 'ConfirmationCard', proposal_id: 'prop_1' }, ctxComp);
    expect(r).toMatchObject({ ok: false });
    // el aviso de error siempre se manda
    expect(compositor.componer({ tipo: 'report_error', codigo: 'AGENTE_SIN_RESOLUCION', mensaje: 'No pude.' }, ctxComp).ok).toBe(true);
  });
});

describe('Compositor: Clarification', () => {
  it('toma etiquetas del registro del servidor y exige ids que salgan de un tool de la intención', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarLectura('leer_tabla', {}, { columnas: [], filas: [{ cosa_id: 'c1', nombre: 'Uno' }, { cosa_id: 'c2', nombre: 'Dos' }] }, 'int_a', 'cosas');
    const ok = compositor.componer({ tipo: 'clarify', pregunta: '¿Cuál?', opciones: [{ id: 'c1', etiqueta: 'Inventada' }, { id: 'c2' }] }, ctxComp);
    expect(ok.ok && ok.opciones).toEqual([{ id: 'c1', etiqueta: 'Uno' }, { id: 'c2', etiqueta: 'Dos' }]);
    const inventada = compositor.componer({ tipo: 'clarify', pregunta: '¿Cuál?', opciones: [{ id: 'c1' }, { id: 'zzz' }] }, ctxComp);
    expect(inventada.ok).toBe(false);
    expect(!inventada.ok && inventada.errores[0]).toContain('zzz');
  });

  it('pide al menos dos opciones distintas', () => {
    const { store, compositor, ctxComp } = bancoDeCompositor();
    store.guardarLectura('leer_tabla', {}, { filas: [{ cosa_id: 'c1', nombre: 'Uno' }] }, 'int_a', 'cosas');
    expect(compositor.componer({ tipo: 'clarify', pregunta: '¿Cuál?', opciones: [{ id: 'c1' }, { id: 'c1' }] }, ctxComp).ok).toBe(false);
  });
});

describe('ContractValidator', () => {
  const v = new ContractValidator();

  it('carga todos los componentes genéricos versionados y ninguno del dominio de ejemplo', () => {
    expect(v.nombresComponentes()).toEqual(['Clarification', 'ConfirmationCard', 'DataTable', 'DetailCard', 'ErrorNotice', 'FormCard', 'KpiTiles', 'StatusToast', 'TrendChart']);
    expect(v.versiones('DataTable')).toEqual([1]);
  });

  it('valida mensajes de la superficie y rechaza los mal formados', () => {
    expect(v.validarMensajeCliente({ v: '1.0', type: 'user.input', message_id: 'm1', text: 'hola' }).ok).toBe(true);
    expect(v.validarMensajeCliente({ v: '1.0', type: 'ui.action', message_id: 'm2', intent_id: 'i', action_id: 'confirmar', confirmation: { confirmation_token: 'x', step_up: { usuario: 'u', pin: '1' } } }).ok).toBe(true);
    const paso = (step_up: Record<string, unknown>): boolean => v.validarMensajeCliente({ v: '1.1', type: 'ui.action', message_id: 'm2', intent_id: 'i', action_id: 'confirmar', confirmation: { confirmation_token: 'x', step_up } }).ok;
    expect(paso({ motivo: 'Cierre de mes' })).toBe(true);
    expect(paso({ usuario: 'u', pin: '1', motivo: 'x' })).toBe(true);
    expect(paso({ usuario: 'u' })).toBe(false); // usuario sin pin
    expect(paso({})).toBe(false);
    expect(paso({ motivo: '' })).toBe(false);
    expect(paso({ motivo: 'x'.repeat(201) })).toBe(false);
    expect(v.validarMensajeCliente({ v: '1.0', type: 'user.input', message_id: 'm1' }).ok).toBe(false);
    expect(v.validarMensajeCliente({ v: '1.0', type: 'ui.action', message_id: 'm', intent_id: 'i', action_id: 'Borrar Todo' }).ok).toBe(false);
  });

  it('valida el sobre y la data del componente', () => {
    const sobre = { v: '1.0', type: 'ui.render', message_id: 'm1234567', session_id: 's', intent_id: 'i', slot: 'main', component: 'DetailCard', component_version: 1, data: { titulo: 'T', campos: [{ etiqueta: 'a', valor: 'b' }] } };
    expect(v.validarSobre(sobre).ok).toBe(true);
    expect(v.validarSobre({ ...sobre, data: { titulo: 'T' } }).ok).toBe(false);
    expect(v.validarSobre({ ...sobre, component: 'Fantasma' }).ok).toBe(false);
  });
});
