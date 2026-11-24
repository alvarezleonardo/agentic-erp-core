import { describe, expect, it } from 'vitest';
import { ErpSintetico, HOY, REGISTRO_AGENTES, TOOLS, contextoDe, crearServidorMcp, generarDatos, saldoDeFacturaProveedor, type FacturaProveedor } from '../src/index.js';

type Obj = Record<string, unknown>;
const gerente = contextoDe('gerente');
const operador = contextoDe('operador');
const CLAVE_SUPERVISOR = '2468';
const nuevoErp = (opciones: ConstructorParameters<typeof ErpSintetico>[0] = {}): ErpSintetico => new ErpSintetico({ autorizadores: { supervisor1: { pin: CLAVE_SUPERVISOR, rol: 'supervisor' } }, ...opciones });
const cent = (d: unknown): number => Number(String((d as { monto: string }).monto).replace('.', ''));
const monto = (centavos: number): string => (centavos / 100).toFixed(2);
const args = (p: { proposal_id: string; confirmation_token: string }, extra: Obj = {}, clave = 'idk_pago_0001'): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: clave, ...extra });
const supervisor = { autorizacion: { usuario: 'supervisor1', pin: CLAVE_SUPERVISOR } };
const campo = (d: { campos: { etiqueta: string; valor: string }[] }, etiqueta: string): string => d.campos.find((c) => c.etiqueta === etiqueta)?.valor ?? '';

/** Facturas con saldo de un proveedor, la que vence primero primero (el orden de imputación). */
const abiertas = (erp: ErpSintetico, proveedor: string): FacturaProveedor[] => erp.datos.facturasProveedor.filter((f) => f.proveedor_id === proveedor && saldoDeFacturaProveedor(f) > 0).sort((a, b) => a.vencimiento.localeCompare(b.vencimiento));
const deuda = (erp: ErpSintetico, proveedor: string): number => abiertas(erp, proveedor).reduce((s, f) => s + saldoDeFacturaProveedor(f), 0);

describe('datos de pagos', () => {
  it('son deterministas, no hay pagos registrados de entrada y hay dos proveedores Gómez', () => {
    const a = generarDatos();
    expect(a.pagosProveedor).toEqual([]);
    expect(a.facturasProveedor).toEqual(generarDatos().facturasProveedor);
    expect(a.proveedores.filter((p) => p.nombre.includes('Gómez')).map((p) => p.id)).toEqual(['prv_05', 'prv_06']);
  });

  it('las facturas vinculadas a órdenes recibidas son por el total de la orden y las abiertas tienen saldo derivado', () => {
    const d = generarDatos();
    for (const f of d.facturasProveedor.filter((x) => x.orden_id)) {
      const orden = d.ordenes.find((o) => o.id === f.orden_id)!;
      expect(orden.estado).toBe('recibida');
      expect(orden.proveedor_id).toBe(f.proveedor_id);
      expect(f.importe).toBe(orden.lineas.reduce((s, l) => s + l.cantidad * l.costo_unitario, 0));
    }
    const parcial = d.facturasProveedor.find((f) => f.id === 'fpr_0003')!;
    expect(parcial.estado).toBe('parcialmente_pagada');
    expect(saldoDeFacturaProveedor(parcial)).toBe(102_000);
  });
});

describe('lecturas', () => {
  it('buscar_proveedores devuelve los dos Gómez para «Gómez» y uno solo para «Gómez Insumos»', () => {
    const erp = nuevoErp();
    expect(erp.buscarProveedores('gomez').filas.map((f) => f['proveedor_id'])).toEqual(['prv_05', 'prv_06']);
    expect(erp.buscarProveedores('Gómez Insumos').filas.map((f) => f['proveedor_id'])).toEqual(['prv_05']);
    expect(() => erp.buscarProveedores('')).toThrow(/proveedor/);
  });

  it('estado de cuenta: saldo, vencido, lo que vence esta semana y lo posterior salen de las facturas', () => {
    const d = nuevoErp().estadoCuentaProveedor({ proveedor_id: 'prv_05' });
    expect(d.proveedor_id).toBe('prv_05');
    expect(campo(d, 'Saldo a pagar')).toBe('2903.00 USD');
    expect(campo(d, 'Vencido')).toBe('1280.00 USD');
    expect(campo(d, 'Vence hasta el 2026-04-05')).toBe('945.00 USD');
    expect(campo(d, 'Vence después')).toBe('678.00 USD');
    expect(d.campos.filter((c) => c.etiqueta.startsWith('Factura ')).length).toBe(3);
    expect(() => nuevoErp().estadoCuentaProveedor({ proveedor_id: 'prv_99' })).toThrow(/No existe el proveedor/);
  });

  it('la agenda de la semana suma lo que vence entre hoy y el domingo, con el vencido aparte', () => {
    const t = nuevoErp().vencimientosProximos({ dias: 5 });
    expect(t.filas.map((f) => f['factura_id'])).toEqual(['fpr_0008', 'fpr_0012', 'fpr_0003', 'fpr_0006']);
    expect(t.titulo).toContain('total 3141.50 USD');
    expect(t.titulo).toContain('Ya vencido y sin pagar: 5629.00 USD');
    expect(t.filas.every((f) => (f['vencimiento'] as string) >= HOY)).toBe(true);
    expect(nuevoErp().vencimientosProximos({ proveedor_id: 'prv_05' }).filas.map((f) => f['factura_id'])).toEqual(['fpr_0012']);
    expect(() => nuevoErp().vencimientosProximos({ dias: 500 })).toThrow(/dias/);
  });

  it('listar_cuentas_a_pagar filtra por proveedor, vencidas y días, ordenado por vencimiento', () => {
    const erp = nuevoErp();
    const todas = erp.listarCuentasAPagar({});
    const venc = todas.filas.map((f) => f['vencimiento'] as string);
    expect(venc).toEqual([...venc].sort());
    expect(todas.filas.some((f) => f['situacion'] === 'pagada')).toBe(false);
    expect(erp.listarCuentasAPagar({ solo_vencidas: true }).filas.map((f) => f['factura_id'])).toEqual(['fpr_0007', 'fpr_0011', 'fpr_0002', 'fpr_0014', 'fpr_0005']);
    expect(erp.listarCuentasAPagar({ proveedor_id: 'prv_06' }).filas).toHaveLength(1);
    expect(erp.listarCuentasAPagar({ vence_en_dias: 0 }).filas.map((f) => f['factura_id'])).toEqual(['fpr_0008']);
    expect(() => erp.listarCuentasAPagar({ solo_vencidas: true, vence_en_dias: 3 })).toThrow(/no las dos/);
  });
});

describe('preparar pago a proveedor', () => {
  it('con un importe reparte entre las facturas, la que vence primero primero, y calcula lo que queda', () => {
    const erp = nuevoErp();
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_01', medio: 'transferencia', importe: '1500' }, gerente);
    expect(cent(p.total)).toBe(150_000);
    expect(p.lineas).toHaveLength(2);
    expect(cent(p.lineas![0]!.importe)).toBe(96_500);
    expect(p.lineas![0]!.descripcion).toContain('0003-00004388');
    expect(p.lineas![0]!.descripcion).toMatch(/queda pagada/);
    expect(cent(p.lineas![1]!.importe)).toBe(53_500);
    expect(p.lineas![1]!.descripcion).toMatch(/queda con saldo 485.00 USD/);
    expect(p.resumen?.find((r) => r.etiqueta === 'Deuda con el proveedor después del pago')?.valor).toBe(`${monto(deuda(erp, 'prv_01') - 150_000)} USD`);
    // Preparar no cambia nada.
    expect(deuda(erp, 'prv_01')).toBe(198_500);
  });

  it('con alcance vencidas o vencen_esta_semana, o con facturas puntuales, paga el saldo del conjunto', () => {
    const erp = nuevoErp();
    expect(cent(erp.prepararPagoProveedor({ proveedor_id: 'prv_05', medio: 'transferencia', alcance: 'vencidas' }, gerente).total)).toBe(128_000);
    expect(cent(erp.prepararPagoProveedor({ proveedor_id: 'prv_05', medio: 'transferencia', alcance: 'vencen_esta_semana' }, gerente).total)).toBe(94_500);
    const dos = erp.prepararPagoProveedor({ proveedor_id: 'prv_01', medio: 'transferencia', facturas: ['fpr_0003', '0003-00004388'] }, gerente);
    expect(cent(dos.total)).toBe(198_500);
    expect(dos.lineas).toHaveLength(2);
    expect(dos.lineas![0]!.descripcion).toContain('0003-00004388'); // aunque se pidió en otro orden, primero la que vence antes
    // Con un importe menor que el conjunto, se imputa solo dentro del conjunto.
    const parte = erp.prepararPagoProveedor({ proveedor_id: 'prv_01', medio: 'transferencia', facturas: ['fpr_0003'], importe: '50' }, gerente);
    expect(parte.lineas).toHaveLength(1);
    expect(parte.lineas![0]!.descripcion).toContain('0003-00004471');
  });

  it('rechaza importes mayores a la deuda, conjuntos vacíos y datos inválidos', () => {
    const erp = nuevoErp();
    const t = (a: Obj) => () => erp.prepararPagoProveedor({ proveedor_id: 'prv_01', medio: 'transferencia', ...a }, gerente);
    expect(t({ importe: monto(deuda(erp, 'prv_01') + 1) })).toThrow(/no puede superar lo que se le debe/);
    expect(t({ facturas: ['fpr_0003'], importe: '1021' })).toThrow(/no puede superar/);
    expect(() => erp.prepararPagoProveedor({ proveedor_id: 'prv_04', medio: 'efectivo', alcance: 'vencidas' }, gerente)).toThrow(/no tiene/);
    expect(t({ facturas: ['fpr_0001'] })).toThrow(/ya está pagada/);
    expect(t({ facturas: ['fpr_0011'] })).toThrow(/es de Gómez Insumos SA/);
    expect(t({ facturas: ['fpr_0099'] })).toThrow(/No existe la factura/);
    expect(t({ facturas: ['fpr_0003'], alcance: 'vencidas' })).toThrow(/no los dos/);
    expect(t({})).toThrow(/Indicá el importe/);
    expect(t({ importe: '0' })).toThrow(/mayor que cero/);
    expect(t({ importe: 'mucho' })).toThrow(/importe/);
    expect(() => erp.prepararPagoProveedor({ proveedor_id: 'prv_01', medio: 'cheque', importe: '10' }, gerente)).toThrow(/medio/);
    expect(() => erp.prepararPagoProveedor({ proveedor_id: 'prv_99', medio: 'efectivo', importe: '10' }, gerente)).toThrow(/No existe el proveedor/);
  });

  it('el servidor vuelve a verificar el rol: solo supervisor y gerente preparan pagos', () => {
    const erp = nuevoErp();
    const a = { proveedor_id: 'prv_01', medio: 'efectivo', importe: '10' };
    expect(() => erp.prepararPagoProveedor(a, operador)).toThrow(/rol/i);
    expect(() => erp.prepararPagoProveedor(a, contextoDe('lectura'))).toThrow(/rol/i);
    expect(() => erp.prepararPagoProveedor(a, contextoDe('supervisor'))).not.toThrow();
    expect(() => erp.prepararPagoProveedor(a, gerente)).not.toThrow();
  });

  it('el step-up combina el umbral de pagos y, en efectivo, el de caja, y los umbrales se configuran', () => {
    const erp = nuevoErp();
    const sp = (medio: string, importe: string, e = erp) => e.prepararPagoProveedor({ proveedor_id: 'prv_02', medio, importe }, gerente).step_up;
    expect(sp('transferencia', '300')).toBeUndefined();
    expect(sp('transferencia', '999.99')).toBeUndefined();
    expect(sp('transferencia', '1000')).toBe('supervisor');
    expect(sp('transferencia', '5000')).toBe('supervisor_y_motivo');
    // En efectivo rige también el umbral de caja (500 y 2000): es más estricto que el de pagos.
    expect(sp('efectivo', '300')).toBeUndefined();
    expect(sp('efectivo', '600')).toBe('supervisor');
    expect(sp('efectivo', '2000')).toBe('supervisor_y_motivo');
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_02', medio: 'transferencia', importe: '1500' }, gerente);
    expect(p.requiere_step_up).toBe(true);
    expect(p.advertencias).toContain('Los pagos a proveedores de 1000.00 o más necesitan la confirmación de un supervisor.');
    const estricto = nuevoErp({ umbralPagoProveedor: 1_000, umbralMotivoPagoProveedor: 2_000 });
    expect(sp('transferencia', '10', estricto)).toBe('supervisor');
    expect(sp('transferencia', '20', estricto)).toBe('supervisor_y_motivo');
  });

  it('avisa del egreso de caja o del débito pendiente, y de una factura cargada dos veces', () => {
    const erp = nuevoErp();
    expect(erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'efectivo', importe: '100' }, gerente).advertencias?.[0]).toMatch(/egreso en la caja/);
    expect(erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'transferencia', importe: '100' }, gerente).advertencias?.[0]).toMatch(/pendiente de débito bancario/);
    const dup = erp.prepararPagoProveedor({ proveedor_id: 'prv_02', medio: 'transferencia', alcance: 'vencidas' }, gerente);
    expect(dup.advertencias?.some((x) => /0011-00077210.*dos veces/.test(x))).toBe(true);
  });
});

describe('confirmar pago a proveedor', () => {
  it('las facturas cambian de estado según lo imputado y la deuda baja exactamente lo pagado', async () => {
    const erp = nuevoErp({ umbralPagoProveedor: 1_000_000_000, umbralMotivoPagoProveedor: 2_000_000_000 });
    const antes = deuda(erp, 'prv_01');
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_01', medio: 'transferencia', importe: '1500' }, gerente);
    const salida = await erp.confirmar('pago_proveedor', args(p), gerente);
    expect(salida).toMatchObject({ estado: 'confirmado', idempotente: false, resultado: { proveedor_id: 'prv_01', estado_bancario: 'pendiente_debito' } });
    const [a, b] = ['fpr_0002', 'fpr_0003'].map((id) => erp.datos.facturasProveedor.find((f) => f.id === id)!);
    expect(a!.estado).toBe('pagada');
    expect(b!.estado).toBe('parcialmente_pagada');
    expect(b!.pagado).toBe(40_000 + 53_500);
    expect(deuda(erp, 'prv_01')).toBe(antes - 150_000);
    expect(cent((salida.resultado as Obj)['saldo_proveedor'])).toBe(antes - 150_000);
    expect(salida.mensaje).toMatch(/pendiente de débito bancario/);
  });

  it('registra el pago con sus imputaciones, lo lista y la transferencia no toca la caja', async () => {
    const erp = nuevoErp();
    const movs = erp.datos.movimientos.length;
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'transferencia', importe: '400' }, gerente);
    await erp.confirmar('pago_proveedor', args(p), gerente);
    expect(erp.datos.movimientos).toHaveLength(movs);
    expect(erp.datos.pagosProveedor[0]).toMatchObject({ numero: 'OP-0001', proveedor_id: 'prv_03', medio: 'transferencia', importe: 40_000, estado_bancario: 'pendiente_debito', fecha: HOY });
    expect(erp.datos.pagosProveedor[0]!.imputaciones).toEqual([{ factura_id: 'fpr_0007', importe: 40_000 }]);
    const lista = erp.listarPagosProveedor({ proveedor_id: 'prv_03' });
    expect(lista.filas).toHaveLength(1);
    expect(lista.filas[0]!['estado_bancario']).toBe('pendiente_debito');
    expect(erp.listarPagosProveedor({ proveedor_id: 'prv_01' }).filas).toHaveLength(0);
    expect(erp.listarPagosProveedor({ desde: HOY, hasta: HOY }).filas).toHaveLength(1);
    expect(() => erp.listarPagosProveedor({ desde: HOY, hasta: '2026-03-01' })).toThrow(/posterior/);
    expect(campo(erp.estadoCuentaProveedor({ proveedor_id: 'prv_03' }), 'Pagos a la espera del débito bancario')).toBe('400.00 USD');
  });

  it('en efectivo deja el egreso en caja con el importe exacto', async () => {
    const erp = nuevoErp();
    const movs = erp.datos.movimientos.length;
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'efectivo', importe: '250,75' }, gerente);
    const salida = await erp.confirmar('pago_proveedor', args(p), gerente);
    expect(erp.datos.movimientos).toHaveLength(movs + 1);
    const mov = erp.datos.movimientos.at(-1)!;
    expect(mov).toMatchObject({ tipo: 'egreso', concepto: 'Pago proveedor Papelera Central', importe: 25_075, fecha: HOY });
    expect((salida.resultado as Obj)['movimiento_caja_id']).toBe(mov.id);
    expect(erp.datos.pagosProveedor[0]?.estado_bancario).toBe('pagado');
  });

  it('repetir la clave no duplica el pago ni el egreso, y una propuesta confirmada no se confirma de nuevo', async () => {
    const erp = nuevoErp();
    const antes = deuda(erp, 'prv_03');
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'efectivo', importe: '400' }, gerente);
    const movs = erp.datos.movimientos.length;
    const primera = await erp.confirmar('pago_proveedor', args(p), gerente);
    const repetida = await erp.confirmar('pago_proveedor', args(p), gerente);
    expect(repetida).toMatchObject({ idempotente: true, resultado: primera.resultado });
    expect(erp.datos.pagosProveedor).toHaveLength(1);
    expect(erp.datos.movimientos).toHaveLength(movs + 1);
    expect(deuda(erp, 'prv_03')).toBe(antes - 40_000);
    await expect(erp.confirmar('pago_proveedor', args(p, {}, 'idk_pago_otra'), gerente)).rejects.toMatchObject({ codigo: 'PROPUESTA_YA_CONFIRMADA' });
  });

  it('vuelve a verificar la deuda al confirmar: si cambió y ya no alcanza, rechaza', async () => {
    const erp = nuevoErp();
    const uno = erp.prepararPagoProveedor({ proveedor_id: 'prv_06', medio: 'transferencia', importe: '300' }, gerente);
    const dos = erp.prepararPagoProveedor({ proveedor_id: 'prv_06', medio: 'transferencia', importe: '300' }, gerente);
    await erp.confirmar('pago_proveedor', args(uno, {}, 'idk_pago_uno'), gerente);
    await expect(erp.confirmar('pago_proveedor', args(dos, {}, 'idk_pago_dos'), gerente)).rejects.toMatchObject({ codigo: 'IMPORTE_EXCEDE_DEUDA' });
    expect(erp.datos.pagosProveedor).toHaveLength(1);
    expect(deuda(erp, 'prv_06')).toBe(15_000);
  });

  it('un pago grande exige un supervisor y uno muy grande también el motivo; en efectivo rige el umbral de caja', async () => {
    const erp = nuevoErp();
    const medio = erp.prepararPagoProveedor({ proveedor_id: 'prv_02', medio: 'transferencia', importe: '1500' }, gerente);
    await expect(erp.confirmar('pago_proveedor', args(medio), gerente)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    await expect(erp.confirmar('pago_proveedor', args(medio, { autorizacion: { usuario: 'supervisor1', pin: 'mal' } }), gerente)).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
    expect(erp.datos.pagosProveedor).toHaveLength(0);
    const ok = await erp.confirmar('pago_proveedor', args(medio, supervisor), gerente);
    expect(ok.estado).toBe('confirmado');
    expect(erp.auditoria.at(-1)).toMatchObject({ tool: 'confirmar_pago_proveedor', autorizo: 'supervisor1' });

    const grande = erp.prepararPagoProveedor({ proveedor_id: 'prv_02', medio: 'transferencia', importe: '3000' }, gerente);
    expect(grande.step_up).toBe('supervisor');
    const muy = nuevoErp().prepararPagoProveedor({ proveedor_id: 'prv_02', medio: 'transferencia', importe: '5000' }, gerente);
    expect(muy.step_up).toBe('supervisor_y_motivo');
    const erp2 = nuevoErp();
    const m = erp2.prepararPagoProveedor({ proveedor_id: 'prv_02', medio: 'transferencia', importe: '5000' }, gerente);
    await expect(erp2.confirmar('pago_proveedor', args(m, supervisor), gerente)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    await erp2.confirmar('pago_proveedor', args(m, { autorizacion: { ...supervisor.autorizacion, motivo: 'Cierre de cuenta del mes' } }), gerente);
    expect(erp2.auditoria.at(-1)).toMatchObject({ autorizo: 'supervisor1', motivo: 'Cierre de cuenta del mes' });

    // 600 en efectivo: bajo el umbral de pagos pero sobre el de caja, así que pide supervisor.
    const erp3 = nuevoErp();
    const ef = erp3.prepararPagoProveedor({ proveedor_id: 'prv_02', medio: 'efectivo', importe: '600' }, gerente);
    await expect(erp3.confirmar('pago_proveedor', args(ef), gerente)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    expect(erp3.datos.movimientos.some((x) => x.concepto.startsWith('Pago proveedor'))).toBe(false);
  });

  it('una propuesta de otro tipo no se confirma como pago, y un operador no confirma', async () => {
    const erp = nuevoErp();
    const mov = erp.prepararMovimientoCaja({ tipo: 'egreso', concepto: 'Limpieza', importe: '10' }, operador);
    await expect(erp.confirmar('pago_proveedor', args(mov), gerente)).rejects.toMatchObject({ codigo: 'PROPUESTA_NO_ENCONTRADA' });
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'efectivo', importe: '10' }, gerente);
    await expect(erp.confirmar('pago_proveedor', args(p), operador)).rejects.toMatchObject({ codigo: 'PERMISO_DENEGADO' });
  });
});

describe('por el servidor MCP y el agente', () => {
  it('el catálogo expone las lecturas y el par preparar/confirmar, valida el esquema y el rol', async () => {
    const { servidor } = crearServidorMcp();
    const { ClienteMcp } = await import('@agentic-erp/mcp-client');
    const c = await ClienteMcp.enMemoria(servidor);
    try {
      const nombres = (await c.listarTools()).map((t) => t.nombre);
      expect(nombres).toEqual(expect.arrayContaining(['buscar_proveedores', 'listar_cuentas_a_pagar', 'estado_cuenta_proveedor', 'vencimientos_proximos', 'listar_pagos_proveedor', 'preparar_pago_proveedor', 'confirmar_pago_proveedor']));
      const sinMedio = await c.llamar('preparar_pago_proveedor', { proveedor_id: 'prv_01', importe: '10' }, gerente);
      expect(sinMedio.datos['codigo']).toBe('PARAMETRO_INVALIDO');
      const ok = await c.llamar('preparar_pago_proveedor', { proveedor_id: 'prv_01', medio: 'transferencia', alcance: 'vencidas' }, gerente);
      expect(ok.ok).toBe(true);
      expect(ok.datos['proposal_id']).toBeTruthy();
      const exceso = await c.llamar('preparar_pago_proveedor', { proveedor_id: 'prv_01', medio: 'transferencia', importe: '999999' }, gerente);
      expect(exceso.datos['codigo']).toBe('IMPORTE_EXCEDE_DEUDA');
      const prohibido = await c.llamar('preparar_pago_proveedor', { proveedor_id: 'prv_01', medio: 'transferencia', importe: '10' }, operador);
      expect(prohibido.datos['codigo']).toBe('PERMISO_DENEGADO');
    } finally {
      await c.cerrar();
    }
  });

  it('el agente de pagos usa tools que existen, no tiene ninguna confirmar_* y no pasa de 15', () => {
    const agente = REGISTRO_AGENTES.todos().find((a) => a.nombre === 'pagos')!;
    const existentes = new Set(TOOLS.map((t) => t.nombre));
    for (const t of agente.tools) expect(existentes.has(t), t).toBe(true);
    expect(agente.tools.some((t) => t.startsWith('confirmar_'))).toBe(false);
    expect(agente.tools.length).toBeLessThanOrEqual(15);
  });
});
