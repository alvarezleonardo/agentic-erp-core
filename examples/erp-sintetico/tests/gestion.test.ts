import { ScriptedProvider } from '@agentic-erp/llm';
import { describe, expect, it } from 'vitest';
import { ARTICULO_BAJO_COSTO, ARTICULO_MARGEN_BAJO, ErpSintetico, HOY, REGISTRO_AGENTES, TOOLS, contextoDe, crearDespliegue, crearServidorMcp, type OpcionesErp } from '../src/index.js';

type Obj = Record<string, unknown>;
const gerente = contextoDe('gerente');
const nuevoErp = (opciones: OpcionesErp = {}): ErpSintetico => new ErpSintetico(opciones);
const args = (p: { proposal_id: string; confirmation_token: string }, clave = 'idk_gestion_0001'): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: clave });
const campo = (d: { campos: { etiqueta: string; valor: string }[] }, etiqueta: string): string => d.campos.find((c) => c.etiqueta === etiqueta)?.valor ?? `(sin campo ${etiqueta})`;
const kpi = (r: { kpis: { id: string; valor: { valor: string } }[] }, id: string): string => r.kpis.find((k) => k.id === id)?.valor.valor ?? `(sin kpi ${id})`;
const alertaPor = (t: { filas: Obj[] }, id: string): Obj | undefined => t.filas.find((f) => f['alerta_id'] === id);

describe('alertas del día', () => {
  const t = nuevoErp().alertasDelDia();

  it('juntan los casos sembrados de las otras áreas, cada uno con su porqué y el área que lo resuelve', () => {
    const esperado: [string, string, string][] = [
      ['anom_ventas_2026-03-24', 'Ventas', 'alta'],
      ['anom_caja_2026-03-28', 'Caja', 'alta'],
      ['alerta_deposito_mov_0213', 'Tesorería y bancos', 'alta'],
      ['alerta_deposito_mov_0255', 'Tesorería y bancos', 'media'],
      ['alerta_facturas_proveedor_vencidas', 'Pagos a proveedores', 'alta'],
      ['alerta_vencimiento_fpr_0008', 'Pagos a proveedores', 'alta'],
      ['alerta_vencimiento_fpr_0012', 'Pagos a proveedores', 'media'],
      ['alerta_vencimiento_fpr_0003', 'Pagos a proveedores', 'media'],
      ['alerta_vencimiento_fpr_0006', 'Pagos a proveedores', 'media'],
      ['alerta_duplicada_fpr_0005', 'Pagos a proveedores', 'alta'],
      ['alerta_limite_cli_07', 'Clientes y cobranzas', 'alta'],
      ['alerta_deuda_cli_05', 'Clientes y cobranzas', 'media'],
      ['alerta_deuda_cli_07', 'Clientes y cobranzas', 'media'],
      ['alerta_stock_bajo_minimo', 'Compras', 'alta'],
      [`alerta_margen_${ARTICULO_BAJO_COSTO}_Distribuidores`, 'Precios y listas', 'alta'],
      [`alerta_margen_${ARTICULO_MARGEN_BAJO}_Mayorista`, 'Precios y listas', 'media'],
    ];
    for (const [id, area, prioridad] of esperado) {
      const a = alertaPor(t, id);
      expect(a, id).toBeDefined();
      expect(a).toMatchObject({ area, prioridad });
      expect(String(a?.['por_que']).length, id).toBeGreaterThan(10);
    }
    expect(t.filas).toHaveLength(esperado.length);
    expect(t.total_filas).toBe(esperado.length);
  });

  it('están ordenadas por prioridad y el título cuenta cada nivel', () => {
    const orden = { alta: 0, media: 1, baja: 2 } as Record<string, number>;
    const niveles = t.filas.map((f) => orden[String(f['prioridad'])] as number);
    expect([...niveles].sort((a, b) => a - b)).toEqual(niveles);
    const n = (p: string): number => t.filas.filter((f) => f['prioridad'] === p).length;
    expect(t.titulo).toBe(`Alertas al ${HOY}: ${t.filas.length} (${n('alta')} altas, ${n('media')} medias, ${n('baja')} bajas)`);
  });

  it('las cifras de cada alerta son las que calculan las otras áreas', () => {
    const erp = nuevoErp();
    const t2 = erp.alertasDelDia();
    expect(alertaPor(t2, 'alerta_deposito_mov_0213')?.['por_que']).toBe('En caja salió 470.24 USD y el banco acreditó 350.24 USD: diferencia de -120.00 USD.');
    expect(alertaPor(t2, 'alerta_limite_cli_07')?.['por_que']).toBe('Debe 25602.60 USD y su límite es 15000.00 USD: lo excede en 10602.60 USD.');
    expect(alertaPor(t2, 'alerta_duplicada_fpr_0005')?.['referencia']).toBe('fpr_0005 y fpr_0015');
    expect(alertaPor(t2, 'alerta_facturas_proveedor_vencidas')?.['por_que']).toMatch(/^Suman 5629\.00 USD y la más vieja venció el 2026-03-13\.$/);
    expect(alertaPor(t2, `alerta_margen_${ARTICULO_BAJO_COSTO}_Distribuidores`)?.['por_que']).toBe('El precio de 119.00 USD es menor que el costo de 124.00 USD.');
  });

  it('reflejan el estado: pagar la factura que vence hoy hace desaparecer su alerta', async () => {
    const erp = nuevoErp();
    expect(alertaPor(erp.alertasDelDia(), 'alerta_vencimiento_fpr_0008')).toBeDefined();
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'transferencia', facturas: ['fpr_0008'] }, gerente);
    await erp.confirmar('pago_proveedor', args(p), gerente);
    expect(alertaPor(erp.alertasDelDia(), 'alerta_vencimiento_fpr_0008')).toBeUndefined();
  });
});

describe('cierre del día', () => {
  it('hoy: ventas contra el mismo día de la semana anterior, caja abierta, bancos y pendientes', () => {
    const erp = nuevoErp();
    const c = erp.cierreDelDia({});
    expect(c.titulo).toBe(`Cierre del martes ${HOY}`);
    const hoy = erp.consultarMetrica(['ventas_total'], HOY, HOY, false).kpis[0]!.valor.valor;
    const semanaAnterior = erp.consultarMetrica(['ventas_total'], '2026-03-24', '2026-03-24', false).kpis[0]!.valor.valor;
    expect(campo(c, 'Ventas del día')).toMatch(new RegExp(`^${hoy} USD en \\d+ unidades$`));
    expect(campo(c, 'Mismo día de la semana anterior (2026-03-24)')).toBe(`${semanaAnterior} USD`);
    const variacion = ((Number(hoy) - Number(semanaAnterior)) / Number(semanaAnterior)) * 100;
    expect(campo(c, 'Variación de ventas')).toBe(`${variacion.toFixed(1)} %`);
    expect(campo(c, 'Caja: arqueo')).toBe('Pendiente, la caja sigue abierta');
    expect(campo(c, 'Cobranzas del día')).toBe('Ninguna');
    expect(campo(c, 'Pagos a proveedores del día')).toBe('Ninguno');
    expect(campo(c, 'Pendiente 1')).toBe('Caja: hacer el arqueo del día');
    const bancos = erp.listarCuentasBancarias().filas;
    for (const b of bancos) expect(campo(c, `Banco: ${String(b['nombre'])}`)).toBe(`${(b['saldo'] as Obj)['monto'] as string} ${(b['saldo'] as Obj)['moneda'] as string}`);
    expect(c.campos.length).toBeLessThanOrEqual(40);
  });

  it('el saldo esperado de caja es el de estado_caja', () => {
    const erp = nuevoErp();
    const caja = erp.estadoCaja(undefined);
    expect(campo(erp.cierreDelDia({}), 'Caja: saldo esperado')).toBe(campo(caja, 'Saldo esperado'));
  });

  it('un día pasado con faltante muestra el arqueo y la diferencia', () => {
    const c = nuevoErp().cierreDelDia({ fecha: '2026-03-28' });
    expect(c.titulo).toBe('Cierre del sábado 2026-03-28');
    expect(campo(c, 'Caja: contado en el arqueo')).toBe('315.50 USD');
    expect(campo(c, 'Caja: diferencia')).toBe('-184.50 USD');
    expect(c.campos.some((x) => x.etiqueta === 'Pendiente 1' && x.valor.startsWith('Caja: hacer el arqueo'))).toBe(false);
  });

  it('los saldos de banco son los de la fecha pedida, no los de hoy', () => {
    const erp = nuevoErp();
    const ayer = erp.cierreDelDia({ fecha: '2026-03-30' });
    const hoy = erp.cierreDelDia({});
    expect(campo(ayer, 'Banco: Banco Nación CC 1234')).toBe('62389.73 USD');
    expect(campo(hoy, 'Banco: Banco Nación CC 1234')).toBe('62456.31 USD');
  });

  it('los pagos del día aparecen en el cierre y en la caja si fueron en efectivo', async () => {
    const erp = nuevoErp();
    const antes = campo(erp.cierreDelDia({}), 'Caja: egresos');
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'efectivo', facturas: ['fpr_0008'] }, gerente);
    await erp.confirmar('pago_proveedor', args(p), gerente);
    const c = erp.cierreDelDia({});
    expect(campo(c, 'Pagos a proveedores del día')).toBe('1 por 312.50 USD');
    expect(campo(c, 'Caja: egresos')).not.toBe(antes);
    expect(c.campos.some((x) => x.valor.includes('Vence hoy la factura 0002-00002015'))).toBe(false);
  });

  it('rechaza una fecha sin datos o con mal formato', () => {
    const erp = nuevoErp();
    expect(() => erp.cierreDelDia({ fecha: '2026-04-05' })).toThrowError(/No hay datos de caja/);
    expect(() => erp.cierreDelDia({ fecha: '2025-12-31' })).toThrowError(/No hay datos de caja/);
    expect(() => erp.cierreDelDia({ fecha: '5 de abril' })).toThrowError(/AAAA-MM-DD/);
  });
});

describe('resumen de gestión', () => {
  it('por defecto es el mes en curso hasta hoy y reutiliza los cálculos de las otras áreas', () => {
    const erp = nuevoErp();
    const r = erp.resumenGestion({});
    expect(r.periodo).toMatchObject({ desde: '2026-03-01', hasta: HOY });
    expect(r.kpis.map((k) => k.id)).toEqual(['ventas_total', 'margen_bruto_pct', 'facturado_total', 'cobrado_total', 'pagado_total', 'deuda_clientes_vencida', 'deuda_proveedores_vencida', 'disponible', 'bancos_ars']);
    const ventas = erp.consultarMetrica(['ventas_total', 'margen_bruto_pct'], '2026-03-01', HOY, true);
    expect(r.kpis[0]).toEqual(ventas.kpis[0]);
    expect(r.kpis[1]).toEqual(ventas.kpis[1]);
    expect(kpi(r, 'facturado_total')).toBe(kpi(erp.resumenFacturacion('2026-03-01', HOY, undefined) as { kpis: { id: string; valor: { valor: string } }[] }, 'facturado_total'));
    const posicion = erp.posicionTesoreria();
    expect(kpi(r, 'disponible')).toBe(kpi(posicion, 'disponible'));
    expect(kpi(r, 'bancos_ars')).toBe(kpi(posicion, 'bancos_ars'));
    expect(r.kpis.length).toBeLessThanOrEqual(12);
  });

  it('la deuda vencida de clientes y de proveedores coincide con deudores y cuentas a pagar', () => {
    const erp = nuevoErp();
    const r = erp.resumenGestion({});
    expect(`${kpi(r, 'deuda_clientes_vencida')}`).toBe('63659.85');
    expect(`${kpi(r, 'deuda_proveedores_vencida')}`).toBe('5629.00');
    expect(erp.listarDeudores({}).titulo).toContain('total vencido 63659.85 USD');
    expect(erp.listarCuentasAPagar({ solo_vencidas: true }).titulo).toContain('total 5629.00 USD');
  });

  it('con un período propio compara contra el anterior y sin cobros ni pagos los deja en cero', () => {
    const r = nuevoErp().resumenGestion({ desde: '2026-02-01', hasta: '2026-02-28' });
    expect(r.periodo).toMatchObject({ desde: '2026-02-01', hasta: '2026-02-28' });
    expect(r.kpis[0]?.comparacion?.periodo_anterior).toBe('2026-01-04 a 2026-01-31');
    expect(kpi(r, 'cobrado_total')).toBe('0.00');
    expect(kpi(r, 'pagado_total')).toBe('0.00');
  });

  it('lo pagado aparece en el período después de confirmar un pago', async () => {
    const erp = nuevoErp();
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'transferencia', facturas: ['fpr_0008'] }, gerente);
    await erp.confirmar('pago_proveedor', args(p), gerente);
    expect(kpi(erp.resumenGestion({}), 'pagado_total')).toBe('312.50');
  });

  it('rechaza un período invertido o con fechas mal escritas', () => {
    const erp = nuevoErp();
    expect(() => erp.resumenGestion({ desde: '2026-03-10', hasta: '2026-03-01' })).toThrowError(/posterior/);
    expect(() => erp.resumenGestion({ desde: 'marzo' })).toThrowError(/AAAA-MM-DD/);
  });
});

describe('por el servidor MCP, el agente y el modo directo', () => {
  it('las tres lecturas están en el catálogo, son para todos los roles y validan el esquema', async () => {
    const { servidor } = crearServidorMcp();
    const { ClienteMcp } = await import('@agentic-erp/mcp-client');
    const c = await ClienteMcp.enMemoria(servidor);
    try {
      const nombres = (await c.listarTools()).map((t) => t.nombre);
      expect(nombres).toEqual(expect.arrayContaining(['cierre_del_dia', 'resumen_gestion', 'alertas_del_dia']));
      for (const rol of ['lectura', 'operador', 'supervisor', 'gerente']) {
        for (const tool of ['cierre_del_dia', 'resumen_gestion', 'alertas_del_dia']) expect((await c.llamar(tool, {}, contextoDe(rol))).ok, `${tool} para ${rol}`).toBe(true);
      }
      const mal = await c.llamar('cierre_del_dia', { fecha: 'ayer' }, gerente);
      expect(mal.datos['codigo']).toBe('PARAMETRO_INVALIDO');
      const sinDatos = await c.llamar('cierre_del_dia', { fecha: '2026-04-05' }, gerente);
      expect(sinDatos.ok).toBe(false);
      expect(sinDatos.datos['codigo']).toBe('PARAMETRO_INVALIDO');
    } finally {
      await c.cerrar();
    }
  });

  it('el agente es de solo lectura: tools que existen, ningún preparar_* ni confirmar_* y no pasa de 15', () => {
    const agente = REGISTRO_AGENTES.todos().find((a) => a.nombre === 'gestion')!;
    const existentes = new Set(TOOLS.map((t) => t.nombre));
    for (const t of agente.tools) expect(existentes.has(t), t).toBe(true);
    expect(agente.tools).toEqual(['cierre_del_dia', 'resumen_gestion', 'alertas_del_dia']);
    expect(agente.tools.some((t) => t.startsWith('confirmar_') || t.startsWith('preparar_'))).toBe(false);
    expect(agente.componentes).not.toContain('ConfirmationCard');
    expect(agente.tools.length).toBeLessThanOrEqual(15);
  });

  it('el cierre arranca sin que nadie escriba: un comando lo corre sin pasar por el modelo, con el componente registrado', async () => {
    const llm = new ScriptedProvider([]);
    const d = await crearDespliegue({ llm });
    try {
      const sesion = d.orquestador.crearSesion(contextoDe('lectura'));
      const comando = (tool: string, a: Obj = {}): Obj => ({ v: '1.1', type: 'user.input', message_id: `m_${tool}`, text: `[aviso] ${tool}`, comando: { tool, args: a } });
      const cierre = await sesion.manejar(comando('cierre_del_dia'));
      expect(cierre).toHaveLength(1);
      expect(cierre[0]).toMatchObject({ type: 'ui.render', component: 'DetailCard' });
      expect((cierre[0]!['data'] as Obj)['titulo']).toBe(`Cierre del martes ${HOY}`);
      expect(sesion.ultimaCorrida?.plan).toMatchObject({ origen: 'comando', plan: ['gestion'] });
      const ayer = await sesion.manejar(comando('cierre_del_dia', { fecha: '2026-03-30' }));
      expect((ayer[0]!['data'] as Obj)['titulo']).toBe('Cierre del lunes 2026-03-30');
      const resumen = await sesion.manejar(comando('resumen_gestion'));
      expect(resumen[0]).toMatchObject({ component: 'KpiTiles' });
      const alertas = await sesion.manejar(comando('alertas_del_dia'));
      expect(alertas[0]).toMatchObject({ component: 'DataTable' });
      for (const s of [...cierre, ...ayer, ...resumen, ...alertas]) expect(d.orquestador.validador.validarSobre(s).ok).toBe(true);
      expect(llm.llamadas).toHaveLength(0);
      const fuera = await sesion.manejar(comando('cierre_del_dia', { fecha: '2026-04-05' }));
      expect(fuera[0]).toMatchObject({ component: 'ErrorNotice', data: { codigo: 'PARAMETRO_INVALIDO' } });
    } finally {
      await d.cerrar();
    }
  });
});
