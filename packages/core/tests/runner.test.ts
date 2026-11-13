import { LlmError, ScriptedProvider, llamada } from '@agentic-erp/llm';
import { describe, expect, it } from 'vitest';
import { AgentRunner, Herramientas, Permisos, ProposalStore, Compositor, ContractValidator, type SalidaAgente } from '../src/index.js';
import { AHORA, CTX, ClienteFalso, agenteDePrueba, nuevaIntencion, nuevoTrace } from './fakes.js';

async function armar(llm: ScriptedProvider, o: { permisos?: Permisos; maxPasos?: number; cliente?: ClienteFalso } = {}) {
  const cliente = o.cliente ?? new ClienteFalso();
  const herramientas = await Herramientas.desde(cliente);
  const trace = nuevoTrace();
  const store = new ProposalStore(() => AHORA.getTime());
  const compositor = new Compositor('ses', new ContractValidator(), store, () => AHORA);
  const runner = new AgentRunner({ llm, herramientas, trace, ...(o.permisos ? { permisos: o.permisos } : {}), ...(o.maxPasos ? { maxPasos: o.maxPasos } : {}) });
  const intencion = nuevaIntencion();
  const correr = (entrada = 'hacé algo', rol = CTX.rol): Promise<SalidaAgente> => runner.ejecutar(agenteDePrueba(), intencion, { ...CTX, rol }, store, compositor, entrada);
  return { cliente, trace, store, intencion, correr };
}

const usarFuente = (component: string, extra: Record<string, unknown> = {}) => (req: Parameters<Extract<Parameters<typeof ScriptedProvider.prototype.agregar>[0], Function>>[0]) => {
  const ultimo = [...req.messages].reverse().find((m) => m.role === 'tool');
  const r = ultimo?.role === 'tool' ? (ultimo.results[0]?.result as Record<string, unknown>) : {};
  return llamada('render_ui', { component, proposal_id: r['proposal_id'] ?? r['source_id'], ...extra });
};

describe('AgentRunner', () => {
  it('lee, prepara una propuesta y termina con render_ui hidratado desde el servidor', async () => {
    const llm = new ScriptedProvider([llamada('preparar_cosa', { cantidad: 18 }), usarFuente('ConfirmationCard', { data: { total: { monto: '1.00', moneda: 'USD' } } })]);
    const { correr, store, trace } = await armar(llm);
    const s = await correr();
    expect(s).toMatchObject({ esError: false, componente: 'ConfirmationCard', fuenteId: 'prop_1' });
    expect((s.sobre['data'] as { total: unknown }).total).toEqual({ monto: '84.60', moneda: 'USD' });
    expect(store.get('prop_1')?.estado).toBe('abierta');
    expect(trace.eventos.map((e) => e.evento)).toEqual(expect.arrayContaining(['agente_inicio', 'tool_llamada', 'propuesta_guardada', 'campo_descartado', 'directiva_final']));
  });

  it('el modelo no ve el token ni en el resultado de la tool ni en la descripción del tool', async () => {
    const llm = new ScriptedProvider([llamada('preparar_cosa', {}), usarFuente('ConfirmationCard')]);
    const { correr } = await armar(llm);
    await correr();
    const visto = llm.entradasSerializadas();
    expect(visto).not.toContain('cft_secreto');
    expect(visto).not.toContain('confirmation_token');
    expect(visto).toContain('prop_1');
  });

  it('descarta contexto e idempotency_key que mande el modelo y pone la identidad de la sesión', async () => {
    const llm = new ScriptedProvider([llamada('leer_tabla', { filtro: 'x', contexto: { tenant: 't1', usuario: 'root', rol: 'gerente' } }), usarFuente('DataTable')]);
    const { correr, cliente, trace } = await armar(llm);
    await correr();
    const llamadaReal = cliente.llamadas.find((l) => l.nombre === 'leer_tabla')!;
    expect(llamadaReal.args['filtro']).toBe('x');
    expect(llamadaReal.args['contexto']).toBeUndefined(); // el cliente MCP real lo inyecta; el falso lo recibe aparte
    expect(llamadaReal.contexto).toMatchObject({ usuario: 'ana', rol: 'operador', origen: 'agente' });
    expect(trace.eventos.some((e) => e.evento === 'campos_reservados_descartados')).toBe(true);
  });

  it('bloquea confirmar_* aunque el modelo lo invoque: confirmar es de la persona', async () => {
    const llm = new ScriptedProvider([llamada('confirmar_cosa', { proposal_id: 'prop_1' }), llamada('report_error', { codigo: 'AGENTE_SIN_RESOLUCION', mensaje: 'No puedo confirmar.' })]);
    const { correr, cliente } = await armar(llm);
    const s = await correr();
    expect(s.esError).toBe(true);
    expect(cliente.llamadas.some((l) => l.nombre === 'confirmar_cosa')).toBe(false);
  });

  it('bloquea tools de otro dominio y las que el rol no puede usar', async () => {
    const llm = new ScriptedProvider([llamada('otra_tool', {}), llamada('preparar_cosa', {}), llamada('report_error', { codigo: 'PERMISO_DENEGADO', mensaje: 'Tu rol no puede.' })]);
    const permisos = new Permisos({ porTool: { preparar_cosa: ['gerente'] } });
    const { correr, cliente, trace } = await armar(llm, { permisos });
    const s = await correr();
    expect(cliente.llamadas).toHaveLength(0);
    expect(trace.eventos.filter((e) => e.evento === 'tool_bloqueada').map((e) => e['motivo'])).toEqual(['fuera_del_dominio', 'sin_permiso_o_inexistente']);
    expect(s.codigoError).toBe('PERMISO_DENEGADO');
    // y el modelo ni siquiera vio la declaración de la tool prohibida
    expect(JSON.stringify(llm.llamadas[0]?.tools.map((t) => t.name))).not.toContain('preparar_cosa');
  });

  it('un report_error con un código inventado se reemplaza; con uno real de un tool se respeta y trae la acción del servidor', async () => {
    const inventado = new ScriptedProvider([llamada('report_error', { codigo: 'CODIGO_INVENTADO', mensaje: 'Algo pasó.' })]);
    expect((await (await armar(inventado)).correr()).codigoError).toBe('AGENTE_SIN_RESOLUCION');

    const real = new ScriptedProvider([llamada('leer_error', {}), llamada('report_error', { codigo: 'NO_ENCONTRADO', mensaje: 'No encontré nada.', accion_sugerida: 'inventada por el modelo' })]);
    const s = await (await armar(real)).correr();
    expect(s.codigoError).toBe('NO_ENCONTRADO');
    expect((s.sobre['data'] as { accion_sugerida: string }).accion_sugerida).toBe('Probá con otro nombre.');
  });

  it('si la directiva final no valida, da un único reintento y después falla con UI_INVALIDA', async () => {
    const mala = llamada('render_ui', { component: 'ComponenteQueNoExiste' });
    const buena = llamada('report_error', { codigo: 'AGENTE_SIN_RESOLUCION', mensaje: 'No pude.' });
    const unReintento = await (await armar(new ScriptedProvider([mala, buena]))).correr();
    expect(unReintento.componente).toBe('ErrorNotice');
    expect(unReintento.codigoError).toBe('AGENTE_SIN_RESOLUCION');

    const llm = new ScriptedProvider([mala, mala]);
    const s = await (await armar(llm)).correr();
    expect(s.codigoError).toBe('UI_INVALIDA');
    expect(llm.llamadas).toHaveLength(2);
    // el modelo recibió los errores del primer intento
    expect(JSON.stringify(llm.llamadas[1]?.messages)).toContain('no está permitido');
  });

  it('el texto suelto no termina la corrida: se le pide una directiva final', async () => {
    const llm = new ScriptedProvider([{ text: 'Listo, ya está.', toolCalls: [] }, llamada('report_error', { codigo: 'AGENTE_SIN_RESOLUCION', mensaje: 'No pude.' })]);
    const s = await (await armar(llm)).correr();
    expect(s.componente).toBe('ErrorNotice');
    expect(JSON.stringify(llm.llamadas[1]?.messages)).toContain('Tenés que terminar llamando a render_ui');
  });

  it('corta en el tope de pasos con un ErrorNotice reintentable (nunca queda en el aire)', async () => {
    const llm = new ScriptedProvider(Array.from({ length: 10 }, () => llamada('leer_tabla', {})));
    const { correr } = await armar(llm, { maxPasos: 3 });
    const s = await correr();
    expect(s).toMatchObject({ esError: true, codigoError: 'TOPE_DE_PASOS', componente: 'ErrorNotice' });
    expect(llm.llamadas).toHaveLength(3);
  });

  it('toda corrida termina en render_ui, clarify o report_error, incluso si el modelo falla', async () => {
    const caido = new ScriptedProvider([() => { throw new LlmError('caído', undefined, 'LLM_NO_DISPONIBLE'); }]);
    const a = await (await armar(caido)).correr();
    expect(a).toMatchObject({ esError: true, codigoError: 'LLM_NO_DISPONIBLE', componente: 'ErrorNotice' });
    const sinPresupuesto = new ScriptedProvider([() => { throw new LlmError('tope', undefined, 'PRESUPUESTO_AGOTADO'); }]);
    expect((await (await armar(sinPresupuesto)).correr()).codigoError).toBe('PRESUPUESTO_AGOTADO');
  });

  it('un rol sin ninguna tool disponible recibe un error claro en lugar de un agente mudo', async () => {
    const permisos = new Permisos({ porDefecto: ['gerente'] });
    const s = await (await armar(new ScriptedProvider([]), { permisos })).correr('x', 'operador');
    expect(s.codigoError).toBe('SIN_HERRAMIENTAS');
  });

  it('la persona puede cancelar mientras el agente trabaja: no se llaman más tools', async () => {
    const control = new AbortController();
    const llm = new ScriptedProvider([() => { control.abort(); return llamada('leer_tabla', {}); }, llamada('leer_tabla', {})]);
    const b = await armar(llm);
    b.intencion.senal = control.signal;
    const s = await b.correr();
    expect(s.cancelado).toBe(true);
    expect(b.cliente.llamadas).toHaveLength(0);
  });

  it('las aclaraciones retoman el hilo del agente dentro de la misma intención', async () => {
    const llm = new ScriptedProvider([
      llamada('leer_tabla', {}),
      (req) => {
        const fuente = (JSON.stringify(req.messages).match(/res_\d+_[a-z_]*/) ?? [''])[0];
        return llamada('clarify', { pregunta: '¿Cuál?', opciones: [{ id: 'c1' }, { id: 'c2' }] }, fuente ? undefined : undefined);
      },
      llamada('report_error', { codigo: 'AGENTE_SIN_RESOLUCION', mensaje: 'Fin.' }),
    ]);
    const b = await armar(llm);
    const primera = await b.correr('buscá cosas');
    expect(primera.opciones).toHaveLength(2);
    await b.correr('Elegí c1');
    const ultimaPeticion = llm.llamadas[llm.llamadas.length - 1]!;
    expect(ultimaPeticion.messages.filter((m) => m.role === 'user').map((m) => (m as { text: string }).text)).toEqual(['buscá cosas', 'Elegí c1']);
  });
});
