import { ScriptedProvider } from '@agentic-erp/llm';
import type { ContextoSesion, Obj, ResultadoTool, ToolMcp } from '@agentic-erp/mcp-contract';
import { describe, expect, it } from 'vitest';
import { Herramientas, Orquestador, Permisos, RegistroAgentes, Router, comandoDeMensaje, vistaPorDefecto, type OpcionesOrquestador } from '../src/index.js';
import { AHORA, CTX, ClienteFalso, TOOLS_FALSAS, agenteDePrueba, nuevoTrace } from './fakes.js';

/** Suma dos lecturas con forma libre (un objeto y una lista) al servidor falso. */
class ClienteConLecturas extends ClienteFalso {
  override async listarTools(): Promise<ToolMcp[]> {
    const esquema = { type: 'object', properties: { contexto: { type: 'object' } }, required: ['contexto'] };
    return [...TOOLS_FALSAS, { nombre: 'leer_objeto', descripcion: 'Un objeto.', esquema }, { nombre: 'leer_lista', descripcion: 'Una lista.', esquema }];
  }

  override async llamar(nombre: string, args: Obj, contexto: ContextoSesion | undefined): Promise<ResultadoTool> {
    if (nombre === 'leer_objeto') {
      this.llamadas.push({ nombre, args: structuredClone(args), contexto: structuredClone(contexto) });
      return { ok: true, datos: { cosa_id: 'c1', nombre: 'Uno', saldo: { monto: '10.00', moneda: 'USD' }, api_key: 'no-debe-verse' } };
    }
    if (nombre === 'leer_lista') {
      this.llamadas.push({ nombre, args: structuredClone(args), contexto: structuredClone(contexto) });
      return { ok: true, datos: { cosas: [{ id: 'c1', importe: { monto: '1.50', moneda: 'USD' } }, { id: 'c2', importe: { monto: '2.00', moneda: 'USD' } }] } };
    }
    return super.llamar(nombre, args, contexto);
  }
}

async function armar(o: Partial<OpcionesOrquestador> = {}, cliente = new ClienteConLecturas()) {
  const llm = new ScriptedProvider([]); // si el modo directo llamara al modelo, el guion vacío haría fallar la prueba
  const herramientas = await Herramientas.desde(cliente);
  const agente = agenteDePrueba({ tools: ['leer_tabla', 'leer_error', 'leer_objeto', 'leer_lista', 'preparar_cosa'] });
  const orq = new Orquestador({ router: new Router({ dominios: [{ nombre: 'cosas', descripcion: 'Cosas' }], reglas: [] }), agentes: new RegistroAgentes([agente]), llm, herramientas, trace: nuevoTrace(), reloj: () => AHORA, ...o });
  const sesion = orq.crearSesion(CTX);
  const msg = (comando: Obj, extra: Obj = {}): Obj => ({ v: '1.1', type: 'user.input', message_id: 'm1', comando, ...extra });
  return { cliente, llm, orq, sesion, msg };
}

describe('modo directo: comando en user.input', () => {
  it('ejecuta la tool sin pasar por el modelo, con el contexto de la sesión y la idempotencia inyectados', async () => {
    const { sesion, llm, cliente, msg } = await armar();
    const sobres = await sesion.manejar(msg({ tool: 'leer_tabla', args: { filtro: 'x', contexto: { tenant: 'otro', usuario: 'root', rol: 'gerente' } } }));
    expect(llm.llamadas).toHaveLength(0);
    const l = cliente.llamadas.find((x) => x.nombre === 'leer_tabla')!;
    expect(l.args['filtro']).toBe('x');
    expect(l.contexto).toMatchObject({ tenant: CTX.tenant, usuario: CTX.usuario, rol: CTX.rol });
    expect(sobres).toHaveLength(1);
    expect(sobres[0]).toMatchObject({ type: 'ui.render', component: 'DataTable' });
    expect(sesion.ultimaCorrida?.plan.origen).toBe('comando');
  });

  it('rechaza siempre confirmar_* con un ErrorNotice y no llama al servidor', async () => {
    const { sesion, cliente, msg } = await armar();
    const sobres = await sesion.manejar(msg({ tool: 'confirmar_cosa', args: { proposal_id: 'prop_1', confirmation_token: 'x', idempotency_key: 'idk_12345678' } }));
    expect(sobres).toHaveLength(1);
    expect(sobres[0]).toMatchObject({ component: 'ErrorNotice', data: { codigo: 'COMANDO_NO_PERMITIDO' } });
    expect(cliente.llamadas).toHaveLength(0);
  });

  it('rechaza una tool desconocida y una sin permiso del rol', async () => {
    const permisos = new Permisos({ porTool: { leer_tabla: ['gerente'] }, porDefecto: 'todos' });
    const { sesion, cliente, msg } = await armar({ permisos });
    const codigo = (s: Awaited<ReturnType<typeof sesion.manejar>>): unknown => (s[0]?.['data'] as Obj)['codigo'];
    expect(codigo(await sesion.manejar(msg({ tool: 'no_existe' })))).toBe('COMANDO_DESCONOCIDO');
    expect(codigo(await sesion.manejar(msg({ tool: 'leer_tabla' })))).toBe('PERMISO_DENEGADO');
    expect(cliente.llamadas).toHaveLength(0);
  });

  it('una lectura con error del servidor se muestra como ErrorNotice con el código del servidor', async () => {
    const { sesion, msg } = await armar();
    const sobres = await sesion.manejar(msg({ tool: 'leer_error' }));
    expect(sobres[0]).toMatchObject({ component: 'ErrorNotice', data: { codigo: 'NO_ENCONTRADO', accion_sugerida: 'Probá con otro nombre.' } });
  });

  it('usa el componente registrado para la tool; si no acepta la salida, cae al genérico', async () => {
    const { sesion, msg, orq } = await armar({ componentesPorTool: { leer_tabla: 'DataTable', leer_objeto: 'KpiTiles' } });
    expect((await sesion.manejar(msg({ tool: 'leer_tabla' })))[0]).toMatchObject({ component: 'DataTable' });
    const objeto = await sesion.manejar(msg({ tool: 'leer_objeto' }));
    expect(objeto[0]).toMatchObject({ component: 'DetailCard' }); // KpiTiles no acepta esa salida
    expect(orq.trace.eventos.some((e) => e.evento === 'comando_componente_incompatible')).toBe(true);
  });

  it('sin mapa: DetailCard para un objeto y DataTable para una lista, y nunca muestra secretos', async () => {
    const { sesion, msg, orq } = await armar();
    const objeto = (await sesion.manejar(msg({ tool: 'leer_objeto' })))[0]!;
    expect(objeto['component']).toBe('DetailCard');
    expect(JSON.stringify(objeto)).toContain('10.00 USD');
    expect(JSON.stringify(objeto)).not.toContain('no-debe-verse');
    const lista = (await sesion.manejar(msg({ tool: 'leer_lista' })))[0]!;
    expect(lista['component']).toBe('DataTable');
    expect(((lista['data'] as Obj)['filas'] as unknown[]).length).toBe(2);
    for (const s of [objeto, lista]) expect(orq.validador.validarSobre(s).ok).toBe(true);
  });

  it('un preparar_* por comando guarda la propuesta y muestra su ConfirmationCard; no confirma nada', async () => {
    const { sesion, cliente, msg } = await armar();
    const sobres = await sesion.manejar(msg({ tool: 'preparar_cosa', args: { cantidad: 3 } }));
    expect(sobres[0]).toMatchObject({ component: 'ConfirmationCard' });
    expect((sobres[0]?.['data'] as Obj)['total']).toEqual({ monto: '84.60', moneda: 'USD' });
    expect(cliente.llamadas.map((l) => l.nombre)).toEqual(['preparar_cosa']);
    expect(sesion.store.get('prop_1')?.estado).toBe('abierta');
  });

  it('el comando cuenta como una intención nueva: abandona las propuestas abiertas de la anterior', async () => {
    const { sesion, msg } = await armar();
    await sesion.manejar(msg({ tool: 'preparar_cosa' }));
    await sesion.manejar(msg({ tool: 'leer_tabla' }));
    expect(sesion.store.get('prop_1')?.estado).toBe('abandonada');
  });
});

describe('protocolo 1.1', () => {
  it('user.input acepta texto, comando o los dos; sin ninguno se rechaza; comando exige v 1.1', async () => {
    const { orq } = await armar();
    const v = (m: Obj): boolean => orq.validador.validarMensajeCliente(m).ok;
    expect(v({ v: '1.0', type: 'user.input', message_id: 'm', text: 'hola' })).toBe(true);
    expect(v({ v: '1.1', type: 'user.input', message_id: 'm', comando: { tool: 'leer_tabla' } })).toBe(true);
    expect(v({ v: '1.1', type: 'user.input', message_id: 'm', text: '[directo] tabla', comando: { tool: 'leer_tabla', args: {} } })).toBe(true);
    expect(v({ v: '1.1', type: 'user.input', message_id: 'm' })).toBe(false);
    expect(v({ v: '1.0', type: 'user.input', message_id: 'm', comando: { tool: 'leer_tabla' } })).toBe(false);
    expect(v({ v: '1.1', type: 'user.input', message_id: 'm', comando: { tool: 'Leer-Tabla' } })).toBe(false);
    expect(v({ v: '1.1', type: 'user.input', message_id: 'm', comando: { tool: 'x_y', extra: 1 } })).toBe(false);
  });

  it('comandoDeMensaje y vistaPorDefecto', () => {
    expect(comandoDeMensaje({ type: 'user.input', text: 'hola' })).toBeUndefined();
    expect(comandoDeMensaje({ comando: { tool: 'a_b', args: { x: 1 } } })).toEqual({ tool: 'a_b', args: { x: 1 } });
    expect(vistaPorDefecto('t', { titulo: 'T', campos: [{ etiqueta: 'a', valor: 'b' }] }).componente).toBe('DetailCard');
    expect(vistaPorDefecto('t', { cosas: [] }).componente).toBe('DetailCard');
  });
});
