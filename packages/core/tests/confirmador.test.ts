import { claveIdempotencia } from '@agentic-erp/mcp-contract';
import { describe, expect, it } from 'vitest';
import { Confirmador, Herramientas, ProposalStore, type Fuente } from '../src/index.js';
import { AHORA, CTX, ClienteFalso, nuevoTrace } from './fakes.js';

async function armar(o: { requiereStepUp?: (f: Fuente) => boolean; paso?: number } = {}) {
  const cliente = new ClienteFalso();
  const herramientas = await Herramientas.desde(cliente);
  const store = new ProposalStore(() => AHORA.getTime());
  const trace = nuevoTrace();
  let ahora = AHORA;
  const confirmador = new Confirmador(store, herramientas, trace, { reloj: () => ahora, ...(o.requiereStepUp ? { requiereStepUp: o.requiereStepUp } : {}) });
  const preparar = async (intentId = 'int_a'): Promise<{ id: string; token: string }> => {
    const r = await cliente.llamar('preparar_cosa', {}, CTX);
    const f = store.guardarPropuesta('preparar_cosa', {}, r.datos, intentId, 'cosas');
    return { id: f.id, token: String(r.datos['confirmation_token']) };
  };
  return { cliente, store, trace, confirmador, preparar, avanzar: (min: number) => { ahora = new Date(ahora.getTime() + min * 60_000); } };
}

describe('Confirmador', () => {
  it('confirma con el token guardado (no con el que mande otro), la identidad humana y una clave de idempotencia', async () => {
    const b = await armar();
    const p = await b.preparar();
    const r = await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token }, CTX, 'tr1');
    expect(r).toMatchObject({ ok: true, idempotente: false, mensaje: 'Cosa confirmada.' });
    const llamada = b.cliente.llamadas.find((l) => l.nombre === 'confirmar_cosa')!;
    expect(llamada.args).toMatchObject({ proposal_id: p.id, confirmation_token: p.token });
    expect(String(llamada.args['idempotency_key'])).toMatch(/^idk_[0-9a-f]{32}$/);
    expect(llamada.contexto?.origen).toBe('humano');
    expect(b.store.get(p.id)?.estado).toBe('confirmada');
  });

  it('sin clave de la superficie, la clave sale del kit: la misma persona y propuesta dan siempre la misma', async () => {
    const b = await armar();
    const p = await b.preparar();
    await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token }, CTX, 'tr1');
    const r = await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token }, CTX, 'tr1');
    expect(r).toMatchObject({ ok: true, idempotente: true });
    expect(b.cliente.llamadas.filter((l) => l.nombre === 'confirmar_cosa')).toHaveLength(1);
    expect(String(b.cliente.llamadas.find((l) => l.nombre === 'confirmar_cosa')?.args['idempotency_key'])).toBe(claveIdempotencia(CTX, p.id));
  });

  it('un token equivocado o ausente se rechaza sin llamar al servidor', async () => {
    const b = await armar();
    const p = await b.preparar();
    expect(await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: 'cft_otro_0123456789abcdef' }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'TOKEN_INVALIDO' });
    expect(await b.confirmador.confirmar({ proposalId: p.id }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'TOKEN_INVALIDO' });
    expect(await b.confirmador.confirmar({ proposalId: 'no_existe', tokenSuperficie: 'x' }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'PROPUESTA_NO_ENCONTRADA' });
    expect(b.cliente.llamadas.filter((l) => l.nombre === 'confirmar_cosa')).toHaveLength(0);
    expect(b.store.get(p.id)?.estado).toBe('abierta');
  });

  it('repetir la confirmación con la misma clave devuelve lo mismo sin volver a llamar al servidor', async () => {
    const b = await armar();
    const p = await b.preparar();
    const sol = { proposalId: p.id, tokenSuperficie: p.token, idempotencyKey: 'idk_mi_clave_unica' };
    await b.confirmador.confirmar(sol, CTX, 'tr1');
    const otra = await b.confirmador.confirmar(sol, CTX, 'tr1');
    expect(otra).toMatchObject({ ok: true, idempotente: true });
    expect(b.cliente.llamadas.filter((l) => l.nombre === 'confirmar_cosa')).toHaveLength(1);
    // sin clave explícita, el doble toque también es seguro (la clave se deriva de la propuesta)
    const q = await b.preparar('int_b');
    await b.confirmador.confirmar({ proposalId: q.id, tokenSuperficie: q.token }, CTX, 'tr1');
    expect(await b.confirmador.confirmar({ proposalId: q.id, tokenSuperficie: q.token }, CTX, 'tr1')).toMatchObject({ ok: true, idempotente: true });
  });

  it('confirmar una propuesta ya confirmada con otra clave es un error, no un segundo efecto', async () => {
    const b = await armar();
    const p = await b.preparar();
    await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token, idempotencyKey: 'idk_clave_numero_1' }, CTX, 'tr1');
    const r = await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token, idempotencyKey: 'idk_clave_numero_2' }, CTX, 'tr1');
    expect(r).toMatchObject({ ok: false, codigo: 'PROPUESTA_YA_CONFIRMADA' });
    expect(b.cliente.llamadas.filter((l) => l.nombre === 'confirmar_cosa')).toHaveLength(1);
  });

  it('las propuestas reemplazadas, abandonadas o vencidas no se pueden confirmar', async () => {
    const b = await armar();
    const vieja = await b.preparar();
    await b.preparar(); // misma tool e intención: reemplaza a la anterior
    expect(await b.confirmador.confirmar({ proposalId: vieja.id, tokenSuperficie: vieja.token }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'PROPUESTA_NO_VIGENTE' });
    const p = await b.preparar('int_x');
    b.store.abandonarIntencion('int_x');
    expect(await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'PROPUESTA_NO_VIGENTE' });
    const q = await b.preparar('int_y');
    b.avanzar(11);
    expect(await b.confirmador.confirmar({ proposalId: q.id, tokenSuperficie: q.token }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'PROPUESTA_EXPIRADA' });
    expect(b.cliente.llamadas.filter((l) => l.nombre === 'confirmar_cosa')).toHaveLength(0);
  });

  it('step-up: sin autorización no se consume nada; con ella pasa al servidor, que es quien la verifica', async () => {
    const b = await armar();
    b.cliente.requiereStepUp = true;
    const p = await b.preparar();
    const sin = await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token }, CTX, 'tr1');
    expect(sin).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO' });
    expect(b.store.get(p.id)?.estado).toBe('abierta');
    expect(b.cliente.llamadas.filter((l) => l.nombre === 'confirmar_cosa')).toHaveLength(0);

    b.cliente.alConfirmar = (args) => ((args['autorizacion'] as { pin: string }).pin === '0000' ? { ok: false, datos: { codigo: 'AUTORIZACION_INVALIDA', mensaje: 'PIN incorrecto.' } } : { ok: true, datos: { estado: 'confirmado', idempotente: false, resultado: {}, mensaje: 'Hecho.' } });
    const mal = await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token, autorizacion: { usuario: 'sup', pin: '0000' } }, CTX, 'tr1');
    expect(mal).toMatchObject({ ok: false, codigo: 'AUTORIZACION_INVALIDA' });
    expect(b.store.get(p.id)?.estado).toBe('abierta'); // se puede reintentar con el PIN correcto
    const bien = await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token, autorizacion: { usuario: 'sup', pin: '1357' } }, CTX, 'tr1');
    expect(bien).toMatchObject({ ok: true });
  });

  it('el despliegue puede exigir step-up con una política propia', async () => {
    const b = await armar({ requiereStepUp: (f) => f.tool === 'preparar_cosa' });
    const p = await b.preparar();
    expect(await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO' });
  });

  it('un rechazo definitivo del servidor cierra la propuesta', async () => {
    const b = await armar();
    b.cliente.alConfirmar = () => ({ ok: false, datos: { codigo: 'PROPUESTA_EXPIRADA', mensaje: 'Venció en el servidor.' } });
    const p = await b.preparar();
    expect(await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token }, CTX, 'tr1')).toMatchObject({ ok: false, codigo: 'PROPUESTA_EXPIRADA' });
    expect(b.store.get(p.id)?.estado).toBe('abandonada');
  });

  it('la traza no contiene el token ni el PIN', async () => {
    const b = await armar();
    b.cliente.requiereStepUp = true;
    const p = await b.preparar();
    await b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token, autorizacion: { usuario: 'sup', pin: '9753' } }, CTX, 'tr1');
    const traza = b.trace.serializado();
    expect(traza).not.toContain(p.token);
    expect(traza).not.toContain('9753');
    expect(traza).toContain('confirmacion_aplicada');
  });

  describe('step-up completo: motivo, supervisor y supervisor_y_motivo', () => {
    const conf = (b: Awaited<ReturnType<typeof armar>>, p: { id: string; token: string }, autorizacion?: { usuario?: string; pin?: string; motivo?: string }) =>
      b.confirmador.confirmar({ proposalId: p.id, tokenSuperficie: p.token, ...(autorizacion ? { autorizacion } : {}) }, CTX, 'tr1');
    const aConfirmar = (b: Awaited<ReturnType<typeof armar>>) => b.cliente.llamadas.filter((l) => l.nombre === 'confirmar_cosa');

    it('motivo: exige un texto, no vale en blanco, y al servidor solo viaja el motivo', async () => {
      const b = await armar();
      b.cliente.stepUp = 'motivo';
      const p = await b.preparar();
      expect(await conf(b, p)).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO', mensaje: expect.stringContaining('motivo') });
      expect(await conf(b, p, { motivo: '   ' })).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO' });
      expect(aConfirmar(b)).toHaveLength(0);
      expect(b.store.get(p.id)?.estado).toBe('abierta');
      // un PIN que la pantalla mande de más no sale de acá: el nivel no lo pide
      expect(await conf(b, p, { usuario: 'sup', pin: '1357', motivo: ' Cierre de mes ' })).toMatchObject({ ok: true });
      expect(aConfirmar(b)[0]?.args['autorizacion']).toEqual({ motivo: 'Cierre de mes' });
    });

    it('supervisor: pide usuario y PIN juntos; el motivo que sobre no viaja', async () => {
      const b = await armar();
      b.cliente.stepUp = 'supervisor';
      const p = await b.preparar();
      expect(await conf(b, p, { usuario: 'sup' })).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO' });
      expect(await conf(b, p, { pin: '1357', motivo: 'x' })).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO' });
      expect(await conf(b, p, { usuario: 'sup', pin: '1357', motivo: 'sobra' })).toMatchObject({ ok: true });
      expect(aConfirmar(b)[0]?.args['autorizacion']).toEqual({ usuario: 'sup', pin: '1357' });
    });

    it('supervisor_y_motivo: pide las dos cosas y dice cuál falta', async () => {
      const b = await armar();
      b.cliente.stepUp = 'supervisor_y_motivo';
      const p = await b.preparar();
      expect(await conf(b, p)).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO', mensaje: expect.stringContaining('responsable y un motivo') });
      expect(await conf(b, p, { usuario: 'sup', pin: '1357' })).toMatchObject({ ok: false, mensaje: expect.stringContaining('motivo') });
      expect(await conf(b, p, { motivo: 'Faltante de caja' })).toMatchObject({ ok: false, mensaje: expect.stringContaining('responsable') });
      expect(aConfirmar(b)).toHaveLength(0);
      expect(await conf(b, p, { usuario: 'sup', pin: '1357', motivo: 'Faltante de caja' })).toMatchObject({ ok: true });
      expect(aConfirmar(b)[0]?.args['autorizacion']).toEqual({ usuario: 'sup', pin: '1357', motivo: 'Faltante de caja' });
    });

    it('un motivo demasiado largo se rechaza sin llamar al servidor', async () => {
      const b = await armar();
      b.cliente.stepUp = 'motivo';
      const p = await b.preparar();
      expect(await conf(b, p, { motivo: 'x'.repeat(201) })).toMatchObject({ ok: false, codigo: 'PARAMETRO_INVALIDO' });
      expect(aConfirmar(b)).toHaveLength(0);
    });

    it('compatibilidad: requiere_step_up equivale a supervisor y la política del despliegue sube motivo a supervisor_y_motivo', async () => {
      const b = await armar();
      b.cliente.requiereStepUp = true;
      const p = await b.preparar();
      expect(await conf(b, p, { motivo: 'solo motivo' })).toMatchObject({ ok: false, codigo: 'STEP_UP_REQUERIDO' });

      const c = await armar({ requiereStepUp: () => true });
      c.cliente.stepUp = 'motivo';
      const q = await c.preparar();
      expect(await conf(c, q, { motivo: 'solo motivo' })).toMatchObject({ ok: false, mensaje: expect.stringContaining('responsable') });
    });

    it('la traza guarda el motivo pero nunca el PIN', async () => {
      const b = await armar();
      b.cliente.stepUp = 'supervisor_y_motivo';
      const p = await b.preparar();
      await conf(b, p, { usuario: 'sup', pin: '9753', motivo: 'Pago urgente de flete' });
      const traza = b.trace.serializado();
      expect(traza).toContain('Pago urgente de flete');
      expect(traza).not.toContain('9753');
      expect(traza).not.toContain(p.token);
    });
  });
});
