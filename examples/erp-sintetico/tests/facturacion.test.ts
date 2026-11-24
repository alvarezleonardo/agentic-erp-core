import { describe, expect, it } from 'vitest';
import { ErpSintetico, HOY, crearServidorMcp, PIN_SUPERVISOR_DE_PRUEBA, contextoDe, estadoDeFactura, generarDatos, saldoDeFactura, type Factura } from '../src/index.js';

type Obj = Record<string, unknown>;
const operador = contextoDe('operador');
const nuevoErp = (opciones: ConstructorParameters<typeof ErpSintetico>[0] = {}): ErpSintetico => new ErpSintetico({ autorizadores: { supervisor1: { pin: PIN_SUPERVISOR_DE_PRUEBA, rol: 'supervisor' } }, ...opciones });
const cent = (d: unknown): number => Number(String((d as { monto: string }).monto).replace('.', ''));
const args = (p: { proposal_id: string; confirmation_token: string }, extra: Obj = {}, clave = 'idk_fact_0001'): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: clave, ...extra });
const supervisor = { autorizacion: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } };

/** Una factura con saldo, sin cobros y de menos de 1000.00 (por debajo del umbral por defecto). */
const chica = (erp: ErpSintetico): Factura => erp.datos.facturas.find((f) => f.estado === 'emitida' && saldoDeFactura(f) < 100_000)!;
const grande = (erp: ErpSintetico): Factura => erp.datos.facturas.find((f) => f.estado === 'emitida' && saldoDeFactura(f) >= 100_000)!;

describe('datos de facturación', () => {
  it('son deterministas y no tocan los datos de ventas y caja', () => {
    const a = generarDatos();
    const b = generarDatos();
    expect(a.facturas).toEqual(b.facturas);
    expect(a.notasCredito).toEqual(b.notasCredito);
    expect(a.ventas.length).toBe(b.ventas.length);
  });

  it('cada factura es coherente: saldo no negativo, estado según importes, numeración correlativa por letra', () => {
    const { facturas, clientes } = generarDatos();
    expect(clientes.length).toBeGreaterThanOrEqual(10);
    for (const f of facturas) {
      expect(saldoDeFactura(f)).toBeGreaterThanOrEqual(0);
      expect(f.estado).toBe(estadoDeFactura(f));
      expect(f.numero).toMatch(/^0001-\d{8}$/);
      expect(f.fecha <= HOY && f.vencimiento >= f.fecha).toBe(true);
      expect(clientes.some((c) => c.id === f.cliente_id)).toBe(true);
    }
    for (const letra of ['A', 'B'] as const) {
      const nums = facturas.filter((f) => f.tipo === letra).map((f) => Number(f.numero.slice(5)));
      expect(nums).toEqual(nums.map((_, i) => (nums[0] as number) + i));
    }
    expect(new Set(facturas.map((f) => f.estado))).toEqual(new Set(['emitida', 'anulada', 'parcialmente_cobrada', 'cobrada']));
  });

  it('tiene los casos sembrados: homónimos, un moroso con todo vencido y un cliente que excede su límite', () => {
    const erp = nuevoErp();
    expect(erp.buscarClientes('Gómez').filas.map((f) => f['nombre'])).toEqual(['Gómez Hnos.', 'Gómez, Laura']);
    const filas = erp.buscarClientes('colegio').filas;
    expect(filas).toHaveLength(1);
    const abiertas = erp.datos.facturas.filter((f) => f.cliente_id === 'cli_05' && saldoDeFactura(f) > 0);
    expect(abiertas.length).toBeGreaterThan(0);
    expect(erp.listarFacturas({ cliente_id: 'cli_05', solo_con_saldo: true }).filas.some((f) => f['vencida'] === true)).toBe(true);
    const excedidos = erp.buscarClientes('a').filas.filter((f) => f['estado'] === 'limite_excedido').map((f) => f['cliente_id']);
    expect(excedidos).toEqual(['cli_07']);
  });
});

describe('lecturas de facturación', () => {
  it('buscar_clientes ignora tildes y mayúsculas, y exige un texto', () => {
    const erp = nuevoErp();
    expect(erp.buscarClientes('GOMEZ hnos').filas.map((f) => f['cliente_id'])).toEqual(['cli_03']);
    expect(erp.buscarClientes('zzzz').total_filas).toBe(0);
    expect(() => erp.buscarClientes('  ')).toThrow(/cliente/);
  });

  it('listar_facturas filtra por cliente, período, estado y saldo; un cliente inexistente es un error', () => {
    const erp = nuevoErp();
    const pendientes = erp.listarFacturas({ cliente_id: 'cli_03', solo_con_saldo: true });
    expect(pendientes.filas.length).toBeGreaterThan(0);
    for (const f of pendientes.filas) expect(cent(f['saldo'])).toBeGreaterThan(0);
    const marzo = erp.listarFacturas({ desde: '2026-03-01', hasta: '2026-03-31' });
    for (const f of marzo.filas) expect(String(f['fecha']).startsWith('2026-03')).toBe(true);
    expect(erp.listarFacturas({ estado: 'anulada' }).filas.every((f) => f['estado'] === 'anulada')).toBe(true);
    expect(() => erp.listarFacturas({ cliente_id: 'cli_99' })).toThrow(/cliente/);
    expect(() => erp.listarFacturas({ desde: '2026-03-31', hasta: '2026-03-01' })).toThrow(/posterior/);
  });

  it('obtener_factura acepta el id o el número, con o sin letra, y muestra el saldo que calcula el servidor', () => {
    const erp = nuevoErp();
    const f = erp.datos.facturas.find((x) => x.estado === 'parcialmente_cobrada')!;
    const porNumero = erp.obtenerFactura({ numero: f.numero });
    expect(porNumero.factura_id).toBe(f.id);
    expect(erp.obtenerFactura({ numero: `${f.tipo} ${f.numero}` }).factura_id).toBe(f.id);
    expect(erp.obtenerFactura({ factura_id: f.id }).campos.find((c) => c.etiqueta === 'Saldo pendiente')?.valor).toBe(`${(saldoDeFactura(f) / 100).toFixed(2)} USD`);
    expect(() => erp.obtenerFactura({ numero: '0001-99999999' })).toThrow(/No existe/);
    expect(() => erp.obtenerFactura({})).toThrow(/factura_id o numero/);
  });

  it('resumen_facturacion: los indicadores salen de las facturas vigentes y las anuladas no cuentan', () => {
    const erp = nuevoErp();
    const r = erp.resumenFacturacion('2026-03-01', HOY, undefined) as { kpis: { id: string; valor: { valor: string } }[] };
    const vigentes = erp.datos.facturas.filter((f) => f.fecha >= '2026-03-01' && f.estado !== 'anulada');
    const facturado = r.kpis.find((k) => k.id === 'facturado_total')!;
    expect(facturado.valor.valor).toBe((vigentes.reduce((s, f) => s + f.importe, 0) / 100).toFixed(2));
    expect(r.kpis.find((k) => k.id === 'comprobantes')!.valor.valor).toBe(String(vigentes.length));
    const todas = erp.datos.facturas.filter((f) => f.fecha >= '2026-03-01').reduce((t, f) => t + f.importe, 0);
    expect(erp.datos.facturas.some((f) => f.fecha >= '2026-03-01' && f.estado === 'anulada')).toBe(true);
    expect(Math.round(Number(facturado.valor.valor) * 100)).toBeLessThan(todas);
  });

  it('resumen_facturacion agrupa por mes, cliente y tipo, y los totales coinciden con el resumen sin agrupar', () => {
    const erp = nuevoErp();
    const total = (r: unknown): number => (r as { filas: { facturado: unknown }[] }).filas.reduce((s, f) => s + cent(f.facturado), 0);
    const kpis = (erp.resumenFacturacion('2026-01-01', HOY, undefined) as { kpis: { id: string; valor: { valor: string } }[] }).kpis;
    const esperado = Math.round(Number(kpis.find((k) => k.id === 'facturado_total')!.valor.valor) * 100);
    for (const g of ['mes', 'cliente', 'tipo']) expect(total(erp.resumenFacturacion('2026-01-01', HOY, g))).toBe(esperado);
    expect((erp.resumenFacturacion('2026-01-01', HOY, 'mes') as unknown as { filas: { grupo: string }[] }).filas.map((f) => f.grupo)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(() => erp.resumenFacturacion('2026-01-01', HOY, 'semana')).toThrow(/agrupar_por/);
  });
});

describe('preparar nota de crédito', () => {
  it('total: el importe es el saldo de la factura, lo calcula el servidor', () => {
    const erp = nuevoErp();
    const f = erp.datos.facturas.find((x) => x.estado === 'parcialmente_cobrada')!;
    const p = erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Artículo fallado' }, operador);
    expect(cent(p.total)).toBe(saldoDeFactura(f));
    expect(p.titulo).toMatch(/total/);
    expect(p.lineas?.[0]?.importe).toEqual(p.total);
  });

  it('parcial: acepta un importe hasta el saldo y rechaza uno mayor', () => {
    const erp = nuevoErp();
    const f = grande(erp);
    const p = erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Bonificación', importe: '150,50' }, operador);
    expect(p.total).toEqual({ monto: '150.50', moneda: 'USD' });
    expect(p.titulo).toMatch(/parcial/);
    expect(() => erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Bonificación', importe: String(saldoDeFactura(f) / 100 + 1) }, operador)).toThrow(/no puede superar el saldo/);
    expect(() => erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Bonificación', importe: '0' }, operador)).toThrow(/mayor que cero/);
    expect(() => erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Bonificación', importe: 'mucho' }, operador)).toThrow(/importe/);
  });

  it('el motivo es obligatorio y se valida en el servidor', () => {
    const erp = nuevoErp();
    const f = chica(erp);
    expect(() => erp.prepararNotaCredito({ factura_id: f.id }, operador)).toThrow(/motivo/);
    expect(() => erp.prepararNotaCredito({ factura_id: f.id, motivo: '  ' }, operador)).toThrow(/motivo/);
    expect(() => erp.prepararNotaCredito({ factura_id: f.id, motivo: 'x'.repeat(121) }, operador)).toThrow(/motivo/);
  });

  it('rechaza facturas anuladas, cobradas por completo e inexistentes', () => {
    const erp = nuevoErp();
    const anulada = erp.datos.facturas.find((f) => f.estado === 'anulada')!;
    const cobrada = erp.datos.facturas.find((f) => f.estado === 'cobrada')!;
    expect(() => erp.prepararNotaCredito({ factura_id: anulada.id, motivo: 'Error' }, operador)).toThrow(/anulada/);
    expect(() => erp.prepararNotaCredito({ factura_id: cobrada.id, motivo: 'Error' }, operador)).toThrow(/cobrada en su totalidad/);
    expect(() => erp.prepararNotaCredito({ factura_id: 'fac_9999', motivo: 'Error' }, operador)).toThrow(/No existe/);
  });

  it('el servidor vuelve a verificar el rol: lectura no puede preparar', () => {
    const erp = nuevoErp();
    expect(() => erp.prepararNotaCredito({ factura_id: chica(erp).id, motivo: 'Error' }, contextoDe('lectura'))).toThrow(/rol/i);
  });

  it('el step-up depende del umbral, que se puede configurar', () => {
    const erp = nuevoErp();
    expect(erp.prepararNotaCredito({ factura_id: chica(erp).id, motivo: 'Error' }, operador).step_up).toBeUndefined();
    const g = erp.prepararNotaCredito({ factura_id: grande(erp).id, motivo: 'Error' }, operador);
    expect(g.step_up).toBe('supervisor');
    expect(g.advertencias).toEqual(['Las notas de crédito de 1000.00 o más necesitan la confirmación de un supervisor.']);

    const estricto = nuevoErp({ umbralNotaCredito: 1_000 });
    const p = estricto.prepararNotaCredito({ factura_id: chica(estricto).id, motivo: 'Error' }, operador);
    expect(p.step_up).toBe('supervisor');
    expect(p.advertencias).toEqual(['Las notas de crédito de 10.00 o más necesitan la confirmación de un supervisor.']);
    const holgado = nuevoErp({ umbralNotaCredito: 100_000_000 });
    expect(holgado.prepararNotaCredito({ factura_id: grande(holgado).id, motivo: 'Error' }, operador).step_up).toBeUndefined();
  });
});

describe('por el servidor MCP', () => {
  it('preparar_nota_credito sin motivo se rechaza por esquema, y el catálogo expone el par preparar/confirmar', async () => {
    const { servidor, erp } = crearServidorMcp();
    const { ClienteMcp } = await import('@agentic-erp/mcp-client');
    const c = await ClienteMcp.enMemoria(servidor);
    try {
      const nombres = (await c.listarTools()).map((t) => t.nombre);
      expect(nombres).toEqual(expect.arrayContaining(['buscar_clientes', 'listar_facturas', 'obtener_factura', 'resumen_facturacion', 'preparar_nota_credito', 'confirmar_nota_credito']));
      const sin = await c.llamar('preparar_nota_credito', { factura_id: chica(erp).id }, operador);
      expect(sin.ok).toBe(false);
      expect(sin.datos['codigo']).toBe('PARAMETRO_INVALIDO');
      const con = await c.llamar('preparar_nota_credito', { factura_id: chica(erp).id, motivo: 'Artículo fallado' }, operador);
      expect(con.ok).toBe(true);
      expect(con.datos['proposal_id']).toBeTruthy();
      const prohibido = await c.llamar('preparar_nota_credito', { factura_id: chica(erp).id, motivo: 'Artículo fallado' }, contextoDe('lectura'));
      expect(prohibido.datos['codigo']).toBe('PERMISO_DENEGADO');
    } finally {
      await c.cerrar();
    }
  });
});

describe('confirmar nota de crédito', () => {
  it('una nota total sobre una factura sin cobros la anula y repetir la clave no duplica', async () => {
    const erp = nuevoErp();
    const f = chica(erp);
    const saldo = saldoDeFactura(f);
    const p = erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Artículo fallado' }, operador);
    const primera = await erp.confirmar('nota_credito', args(p), operador);
    expect(primera).toMatchObject({ estado: 'confirmado', idempotente: false, resultado: { factura_id: f.id, estado_factura: 'anulada' } });
    const repetida = await erp.confirmar('nota_credito', args(p), operador);
    expect(repetida).toMatchObject({ idempotente: true, resultado: primera.resultado });
    expect(f.acreditado).toBe(saldo);
    expect(f.estado).toBe('anulada');
    expect(erp.datos.notasCredito.filter((n) => n.factura_id === f.id)).toHaveLength(1);
    expect(erp.datos.notasCredito.find((n) => n.factura_id === f.id)).toMatchObject({ motivo: 'Artículo fallado', importe: saldo, fecha: HOY });
    expect(erp.consumirEventos(0, ['nota_credito_emitida'], undefined).eventos).toHaveLength(1);
    expect(() => erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Otra vez' }, operador)).toThrow(/anulada/);
  });

  it('una nota parcial baja el saldo y deja la factura abierta; la numeración de notas sigue la serie de la letra', async () => {
    const erp = nuevoErp();
    const f = grande(erp);
    const antes = saldoDeFactura(f);
    const ultima = Math.max(...erp.datos.notasCredito.filter((n) => n.tipo === f.tipo).map((n) => Number(n.numero.slice(5))));
    const p = erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Bonificación', importe: '100' }, operador);
    await erp.confirmar('nota_credito', args(p, supervisor), operador);
    expect(saldoDeFactura(f)).toBe(antes - 10_000);
    expect(f.estado).toBe('emitida');
    expect(erp.datos.notasCredito.at(-1)?.numero).toBe(`0001-${String(ultima + 1).padStart(8, '0')}`);
  });

  it('una nota que deja saldo cero sobre una factura con cobros la deja cobrada, no anulada', async () => {
    const erp = nuevoErp();
    const objetivo = erp.datos.facturas.find((x) => x.estado === 'parcialmente_cobrada')!;
    const p = erp.prepararNotaCredito({ factura_id: objetivo.id, motivo: 'Ajuste de saldo' }, operador);
    await erp.confirmar('nota_credito', args(p, p.step_up ? supervisor : {}), operador);
    expect(objetivo.estado).toBe('cobrada');
  });

  it('sobre el umbral exige un supervisor: sin credencial o con una incorrecta no pasa, y nadie se autoriza a sí mismo', async () => {
    const erp = nuevoErp();
    const f = grande(erp);
    const p = erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Error de precio' }, operador);
    await expect(erp.confirmar('nota_credito', args(p), operador)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    await expect(erp.confirmar('nota_credito', args(p, { autorizacion: { usuario: 'supervisor1', pin: '0000' } }), operador)).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
    expect(f.acreditado).toBe(0);
    const propia = erp.prepararNotaCredito({ factura_id: grande(erp).id, motivo: 'Error de precio' }, contextoDe('supervisor', 'supervisor1'));
    await expect(erp.confirmar('nota_credito', args(propia, supervisor, 'idk_fact_0002'), contextoDe('supervisor', 'supervisor1'))).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
    await erp.confirmar('nota_credito', args(p, supervisor, 'idk_fact_0003'), operador);
    expect(f.acreditado).toBeGreaterThan(0);
    expect(erp.auditoria.find((a) => a.tool === 'confirmar_nota_credito')).toMatchObject({ autorizo: 'supervisor1', origen: 'sin_origen' });
  });

  it('si el saldo cambió entre preparar y confirmar, el servidor vuelve a verificar', async () => {
    const erp = nuevoErp();
    const f = grande(erp);
    const p = erp.prepararNotaCredito({ factura_id: f.id, motivo: 'Error de precio' }, operador);
    f.cobrado = f.importe - 10_000; // otra operación cobró casi todo mientras tanto
    f.estado = estadoDeFactura(f);
    await expect(erp.confirmar('nota_credito', args(p, supervisor), operador)).rejects.toMatchObject({ codigo: 'IMPORTE_EXCEDE_SALDO' });
    f.cobrado = f.importe;
    f.estado = estadoDeFactura(f);
    await expect(erp.confirmar('nota_credito', args(p, supervisor, 'idk_fact_0004'), operador)).rejects.toMatchObject({ codigo: 'FACTURA_NO_ACREDITABLE' });
  });

  it('solo quien preparó la propuesta puede confirmarla, y una propuesta de otro tipo no sirve', async () => {
    const erp = nuevoErp();
    const p = erp.prepararNotaCredito({ factura_id: chica(erp).id, motivo: 'Error' }, operador);
    await expect(erp.confirmar('nota_credito', args(p), contextoDe('operador', 'otro'))).rejects.toThrow(/preparó/);
    await expect(erp.confirmar('movimiento_caja', args(p), operador)).rejects.toMatchObject({ codigo: 'PROPUESTA_NO_ENCONTRADA' });
  });
});
