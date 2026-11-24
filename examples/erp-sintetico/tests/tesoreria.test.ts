import { describe, expect, it } from 'vitest';
import { DEPOSITO_CON_DIFERENCIA, DEPOSITO_SIN_ACREDITAR, ErpSintetico, HOY, REGISTRO_AGENTES, TOOLS, contextoDe, crearServidorMcp, generarDatos, saldoDeCuenta, type OpcionesErp } from '../src/index.js';

type Obj = Record<string, unknown>;
const gerente = contextoDe('gerente');
const operador = contextoDe('operador');
const CLAVE_SUPERVISOR = '2468';
/** Nombre del campo de la credencial en el contrato de autorización. */
const autorizadores = { supervisor1: { pin: CLAVE_SUPERVISOR, rol: 'supervisor' } as NonNullable<OpcionesErp['autorizadores']>[string] };
const nuevoErp = (opciones: OpcionesErp = {}): ErpSintetico => new ErpSintetico({ autorizadores, ...opciones });
const supervisor = { autorizacion: { usuario: 'supervisor1', pin: CLAVE_SUPERVISOR } };
const args = (p: { proposal_id: string; confirmation_token: string }, extra: Obj = {}, clave = 'idk_tesoreria_0001'): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: clave, ...extra });
const cent = (d: unknown): number => Number(String((d as { monto: string }).monto).replace('.', ''));
const saldo = (erp: ErpSintetico, id: string): number => saldoDeCuenta(erp.datos.cuentasBancarias.find((c) => c.id === id)!, erp.datos.movimientosBancarios);
const NACION = 'cta_01';
const GALICIA = 'cta_02';
const SANTANDER = 'cta_03';

describe('datos de tesorería', () => {
  it('son deterministas y las transferencias internas arrancan vacías', () => {
    const a = generarDatos();
    expect(a.transferenciasInternas).toEqual([]);
    expect(a.cuentasBancarias).toEqual(generarDatos().cuentasBancarias);
    expect(a.movimientosBancarios).toEqual(generarDatos().movimientosBancarios);
    expect(a.cuentasBancarias.map((c) => [c.id, c.moneda])).toEqual([[NACION, 'USD'], [GALICIA, 'USD'], [SANTANDER, 'ARS']]);
  });

  it('hay un crédito por cada depósito de caja salvo uno, y un solo depósito acreditado por menos', () => {
    const d = generarDatos();
    const depositos = d.movimientos.filter((m) => m.tipo === 'egreso' && m.concepto === 'Depósito bancario');
    const creditos = d.movimientosBancarios.filter((m) => m.tipo === 'deposito_caja');
    expect(creditos).toHaveLength(depositos.length - 1);
    expect(depositos.find((m) => m.fecha === DEPOSITO_SIN_ACREDITAR)).toBeDefined();
    const iguales = depositos.filter((dep) => creditos.some((c) => c.importe === dep.importe && c.fecha >= dep.fecha && c.fecha <= HOY));
    expect(iguales).toHaveLength(depositos.length - 2);
    for (const c of creditos) expect(c.fecha <= HOY).toBe(true);
    // Los créditos de depósito llegan 0 a 2 días después del egreso de caja.
    for (const dep of depositos.filter((x) => x.fecha !== DEPOSITO_SIN_ACREDITAR && x.fecha !== DEPOSITO_CON_DIFERENCIA)) {
      const c = creditos.find((x) => x.importe === dep.importe && x.fecha >= dep.fecha)!;
      expect(Date.parse(c.fecha) - Date.parse(dep.fecha)).toBeLessThanOrEqual(2 * 86_400_000);
    }
  });

  it('el saldo de una cuenta es el inicial más créditos menos débitos, y hay pagos previos a proveedores como débitos', () => {
    const d = generarDatos();
    const nacion = d.cuentasBancarias[0]!;
    const neto = d.movimientosBancarios.filter((m) => m.cuenta_id === nacion.id).reduce((s, m) => s + (m.sentido === 'credito' ? m.importe : -m.importe), 0);
    expect(saldoDeCuenta(nacion, d.movimientosBancarios)).toBe(nacion.saldo_inicial + neto);
    const pagadoPrevio = d.facturasProveedor.reduce((s, f) => s + f.pagado, 0);
    expect(d.movimientosBancarios.filter((m) => m.tipo === 'debito_proveedor').reduce((s, m) => s + m.importe, 0)).toBe(pagadoPrevio);
    expect(d.movimientosBancarios.some((m) => m.tipo === 'comision')).toBe(true);
    expect(d.movimientosBancarios.some((m) => m.tipo === 'impuesto')).toBe(true);
    expect(d.movimientosBancarios.some((m) => m.tipo === 'acreditacion_cliente')).toBe(true);
  });
});

describe('lecturas', () => {
  it('listar_cuentas_bancarias trae el saldo de cada cuenta en su moneda y los totales no mezclan monedas', () => {
    const erp = nuevoErp();
    const t = erp.listarCuentasBancarias();
    expect(t.filas.map((f) => f['cuenta_id'])).toEqual([NACION, GALICIA, SANTANDER]);
    for (const f of t.filas) {
      const dinero = f['saldo'] as { monto: string; moneda: string };
      expect(dinero.moneda).toBe(f['moneda']);
      expect(cent(dinero)).toBe(saldo(erp, f['cuenta_id'] as string));
    }
    expect(t.titulo).toContain('USD');
    expect(t.titulo).toContain('ARS');
    const usd = (saldo(erp, NACION) + saldo(erp, GALICIA)) / 100;
    expect(t.titulo).toContain(`USD ${usd.toFixed(2)}`);
  });

  it('listar_movimientos_bancarios filtra por cuenta, período y tipo, y los créditos van con signo positivo y los débitos negativo', () => {
    const erp = nuevoErp();
    const marzo = erp.listarMovimientosBancarios({ cuenta_id: NACION, desde: '2026-03-01', hasta: '2026-03-31' });
    expect(marzo.filas.length).toBeGreaterThan(20);
    expect(marzo.filas.every((f) => (f['fecha'] as string).startsWith('2026-03') && f['cuenta'] === 'Banco Nación CC 1234')).toBe(true);
    const fechas = marzo.filas.map((f) => f['fecha'] as string);
    expect(fechas).toEqual([...fechas].sort().reverse());
    expect(marzo.titulo!.length).toBeLessThanOrEqual(120);
    const deb = erp.listarMovimientosBancarios({ cuenta_id: NACION, tipo: 'debito_proveedor' });
    expect(deb.filas.length).toBeGreaterThan(0);
    expect(deb.filas.every((f) => cent(f['importe']) < 0)).toBe(true);
    const cred = erp.listarMovimientosBancarios({ tipo: 'deposito_caja' });
    expect(cred.filas.every((f) => cent(f['importe']) > 0)).toBe(true);
    const santander = erp.listarMovimientosBancarios({ cuenta_id: SANTANDER });
    expect(santander.filas.every((f) => (f['importe'] as { moneda: string }).moneda === 'ARS')).toBe(true);
    expect(erp.listarMovimientosBancarios({ limite: 5 }).filas).toHaveLength(5);
    expect(erp.listarMovimientosBancarios({ limite: 5 }).total_filas).toBe(erp.datos.movimientosBancarios.length);
    expect(() => erp.listarMovimientosBancarios({ cuenta_id: 'cta_99' })).toThrow(/No existe la cuenta/);
    expect(() => erp.listarMovimientosBancarios({ tipo: 'otro' })).toThrow(/tipo/);
    expect(() => erp.listarMovimientosBancarios({ desde: HOY, hasta: '2026-03-01' })).toThrow(/posterior/);
  });

  it('conciliar_depositos de marzo encuentra exactamente una diferencia y un pendiente, y el resto concilia', () => {
    const erp = nuevoErp();
    const t = erp.conciliarDepositos({ desde: '2026-03-01', hasta: '2026-03-31' });
    expect(t.filas).toHaveLength(2);
    const dif = t.filas.find((f) => f['estado'] === 'con_diferencia')!;
    const pen = t.filas.find((f) => f['estado'] === 'pendiente')!;
    expect(dif['fecha_caja']).toBe(DEPOSITO_CON_DIFERENCIA);
    expect(cent(dif['diferencia'])).toBe(-12_000);
    expect(cent(dif['importe_caja']) + cent(dif['diferencia'])).toBe(cent(dif['importe_banco']));
    expect(pen['fecha_caja']).toBe(DEPOSITO_SIN_ACREDITAR);
    expect(pen['importe_banco']).toBeUndefined();
    expect(t.titulo).toContain('Conciliados 28');
    expect(t.titulo).toContain('con diferencia 1 (-120.00 USD)');
    expect(t.titulo).toContain(`pendientes 1 (${(cent(pen['importe_caja']) / 100).toFixed(2)} USD)`);
    expect(t.titulo!.length).toBeLessThanOrEqual(120);
    const todo = erp.conciliarDepositos({ desde: '2026-03-01', hasta: '2026-03-31', incluir_conciliados: true });
    expect(todo.filas).toHaveLength(30);
    expect(todo.filas.filter((f) => f['estado'] === 'conciliado')).toHaveLength(28);
  });

  it('el resultado de un día no depende de lo que se pidió alrededor: pedir solo el depósito pendiente lo deja pendiente', () => {
    const erp = nuevoErp();
    const solo = erp.conciliarDepositos({ desde: DEPOSITO_SIN_ACREDITAR, hasta: DEPOSITO_SIN_ACREDITAR });
    expect(solo.filas.map((f) => f['estado'])).toEqual(['pendiente']);
    const dia = erp.conciliarDepositos({ desde: DEPOSITO_CON_DIFERENCIA, hasta: DEPOSITO_CON_DIFERENCIA });
    expect(dia.filas.map((f) => f['estado'])).toEqual(['con_diferencia']);
    const ene = erp.conciliarDepositos({ desde: '2026-01-01', hasta: '2026-02-28' });
    expect(ene.filas).toHaveLength(0);
    expect(ene.titulo).toContain('con diferencia 0');
    expect(() => erp.conciliarDepositos({ desde: '2026-03-31', hasta: '2026-03-01' })).toThrow(/posterior/);
    expect(() => erp.conciliarDepositos({ desde: 'ayer', hasta: HOY })).toThrow(/fecha/);
  });

  it('un depósito de caja nuevo queda pendiente hasta que el banco lo acredite, y una transferencia interna no se confunde con un depósito', async () => {
    const erp = nuevoErp({ umbralesCaja: { supervisor: 10_000_000, supervisorYMotivo: 20_000_000 } });
    const p = erp.prepararMovimientoCaja({ tipo: 'egreso', concepto: 'Depósito bancario', importe: '300' }, operador);
    await erp.confirmar('movimiento_caja', args(p, {}, 'idk_deposito_nuevo'), operador);
    const hoy = erp.conciliarDepositos({ desde: HOY, hasta: HOY });
    expect(hoy.filas).toHaveLength(1);
    expect(hoy.filas[0]).toMatchObject({ estado: 'pendiente', fecha_caja: HOY });
    const t = erp.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '300' }, operador);
    await erp.confirmar('transferencia_interna', args(t, {}, 'idk_ti_sin_efecto'), operador);
    expect(erp.conciliarDepositos({ desde: HOY, hasta: HOY }).filas.map((f) => f['estado'])).toEqual(['pendiente']);
  });

  it('posicion_tesoreria suma caja, bancos por moneda, lo pendiente de débito y los vencimientos de 7 días', async () => {
    const erp = nuevoErp();
    const k = (e: ErpSintetico, id: string): number => cent({ monto: e.posicionTesoreria().kpis.find((x) => x.id === id)!.valor.valor });
    const caja = cent({ monto: erp.estadoCaja(HOY).campos.find((c) => c.etiqueta === 'Saldo esperado')!.valor.split(' ')[0]! });
    expect(k(erp, 'caja')).toBe(caja);
    expect(k(erp, 'bancos_usd')).toBe(saldo(erp, NACION) + saldo(erp, GALICIA));
    expect(k(erp, 'bancos_ars')).toBe(saldo(erp, SANTANDER));
    expect(erp.posicionTesoreria().kpis.find((x) => x.id === 'bancos_ars')!.valor.moneda).toBe('ARS');
    expect(k(erp, 'pendiente_debito')).toBe(0);
    // Con los datos sembrados lo que vence en 7 días es lo mismo que la agenda de pagos a 7 días.
    expect(k(erp, 'vencen_7_dias')).toBe(314_150);
    expect(k(erp, 'disponible')).toBe(caja + k(erp, 'bancos_usd'));
    expect(k(erp, 'disponible_tras_vencimientos')).toBe(k(erp, 'disponible') - 314_150);
    // Una transferencia a un proveedor queda pendiente de débito: no baja los bancos, sí lo disponible.
    const antesBancos = k(erp, 'bancos_usd');
    const antesDisponible = k(erp, 'disponible');
    const p = erp.prepararPagoProveedor({ proveedor_id: 'prv_03', medio: 'transferencia', importe: '400' }, gerente);
    await erp.confirmar('pago_proveedor', args(p, {}, 'idk_pago_pos'), gerente);
    expect(k(erp, 'pendiente_debito')).toBe(40_000);
    expect(k(erp, 'bancos_usd')).toBe(antesBancos);
    expect(k(erp, 'disponible')).toBe(antesDisponible - 40_000);
    // Los títulos de los indicadores entran en el componente (60 caracteres).
    for (const kpi of erp.posicionTesoreria().kpis) expect(kpi.etiqueta.length).toBeLessThanOrEqual(60);
  });
});

describe('preparar transferencia interna', () => {
  it('calcula los saldos de las dos cuentas antes y después, y la propuesta lleva el total en la moneda de las cuentas', () => {
    const erp = nuevoErp();
    const p = erp.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '2000' }, operador);
    const campo = (e: string): string => p.resumen!.find((r) => r.etiqueta === e)!.valor;
    expect(campo('Saldo de origen antes')).toBe(`${(saldo(erp, NACION) / 100).toFixed(2)} USD`);
    expect(campo('Saldo de origen después')).toBe(`${((saldo(erp, NACION) - 200_000) / 100).toFixed(2)} USD`);
    expect(campo('Saldo de destino después')).toBe(`${((saldo(erp, GALICIA) + 200_000) / 100).toFixed(2)} USD`);
    expect(p.total).toEqual({ monto: '2000.00', moneda: 'USD' });
    expect(p.lineas).toHaveLength(2);
    expect(p.step_up).toBeUndefined();
    expect(erp.datos.transferenciasInternas).toHaveLength(0);
  });

  it('rechaza monedas distintas, la misma cuenta, saldo insuficiente, importes inválidos y cuentas que no existen', () => {
    const erp = nuevoErp();
    const base = { cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '100' };
    for (const [origen, destino] of [[NACION, SANTANDER], [SANTANDER, GALICIA]] as const) {
      expect(() => erp.prepararTransferenciaInterna({ ...base, cuenta_origen_id: origen, cuenta_destino_id: destino }, gerente)).toThrow(/monedas distintas/);
    }
    try {
      erp.prepararTransferenciaInterna({ ...base, cuenta_destino_id: SANTANDER }, gerente);
    } catch (e) {
      expect(e).toMatchObject({ codigo: 'MONEDAS_DISTINTAS' });
    }
    expect(() => erp.prepararTransferenciaInterna({ ...base, cuenta_destino_id: NACION }, gerente)).toThrow(/la misma/);
    const exceso = ((saldo(erp, GALICIA) + 1) / 100).toFixed(2);
    expect(() => erp.prepararTransferenciaInterna({ cuenta_origen_id: GALICIA, cuenta_destino_id: NACION, importe: exceso }, gerente)).toThrow(/no alcanza/);
    try {
      erp.prepararTransferenciaInterna({ cuenta_origen_id: GALICIA, cuenta_destino_id: NACION, importe: exceso }, gerente);
    } catch (e) {
      expect(e).toMatchObject({ codigo: 'SALDO_INSUFICIENTE' });
    }
    // Justo el saldo completo sí se puede.
    expect(() => erp.prepararTransferenciaInterna({ cuenta_origen_id: GALICIA, cuenta_destino_id: NACION, importe: (saldo(erp, GALICIA) / 100).toFixed(2) }, gerente)).not.toThrow();
    for (const importe of ['0', '-5', 'abc', '']) expect(() => erp.prepararTransferenciaInterna({ ...base, importe }, gerente)).toThrow(/importe/i);
    expect(() => erp.prepararTransferenciaInterna({ ...base, cuenta_origen_id: 'cta_99' }, gerente)).toThrow(/No existe la cuenta/);
    expect(() => erp.prepararTransferenciaInterna({ ...base, cuenta_destino_id: 'cta_99' }, gerente)).toThrow(/No existe la cuenta/);
  });

  it('el servidor vuelve a verificar el rol: un rol de solo lectura no prepara', () => {
    const erp = nuevoErp();
    const a = { cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '10' };
    expect(() => erp.prepararTransferenciaInterna(a, contextoDe('lectura'))).toThrow(/rol/i);
    for (const rol of ['operador', 'supervisor', 'gerente']) expect(() => erp.prepararTransferenciaInterna(a, contextoDe(rol))).not.toThrow();
  });

  it('pide un supervisor desde el umbral, que se configura', () => {
    const erp = nuevoErp();
    const sp = (importe: string, e = erp) => e.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe }, operador);
    expect(sp('4999.99').step_up).toBeUndefined();
    const grande = sp('5000');
    expect(grande.step_up).toBe('supervisor');
    expect(grande.requiere_step_up).toBe(true);
    expect(grande.advertencias).toContain('Las transferencias internas de 5000.00 o más necesitan la confirmación de un supervisor.');
    expect(sp('10', nuevoErp({ umbralTransferenciaInterna: 1_000 })).step_up).toBe('supervisor');
    expect(sp('9.99', nuevoErp({ umbralTransferenciaInterna: 1_000 })).step_up).toBeUndefined();
  });
});

describe('confirmar transferencia interna', () => {
  it('mueve exactamente el importe: debita el origen, acredita el destino, deja dos movimientos y no toca la caja ni los pagos', async () => {
    const erp = nuevoErp();
    const [n0, g0] = [saldo(erp, NACION), saldo(erp, GALICIA)];
    const movsBanco = erp.datos.movimientosBancarios.length;
    const movsCaja = erp.datos.movimientos.length;
    const p = erp.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '2000,50' }, operador);
    const salida = await erp.confirmar('transferencia_interna', args(p), operador);
    expect(salida).toMatchObject({ estado: 'confirmado', idempotente: false, resultado: { numero: 'TI-0001', transferencia_id: 'tri_0001' } });
    expect(saldo(erp, NACION)).toBe(n0 - 200_050);
    expect(saldo(erp, GALICIA)).toBe(g0 + 200_050);
    expect(cent((salida.resultado as Obj)['saldo_origen'])).toBe(n0 - 200_050);
    expect(cent((salida.resultado as Obj)['saldo_destino'])).toBe(g0 + 200_050);
    expect(erp.datos.movimientosBancarios).toHaveLength(movsBanco + 2);
    const [deb, cre] = erp.datos.movimientosBancarios.slice(-2);
    expect(deb).toMatchObject({ cuenta_id: NACION, sentido: 'debito', tipo: 'transferencia_interna', importe: 200_050, fecha: HOY });
    expect(cre).toMatchObject({ cuenta_id: GALICIA, sentido: 'credito', tipo: 'transferencia_interna', importe: 200_050, fecha: HOY });
    expect(erp.datos.transferenciasInternas).toEqual([{ id: 'tri_0001', numero: 'TI-0001', fecha: HOY, origen_id: NACION, destino_id: GALICIA, importe: 200_050 }]);
    expect(erp.datos.movimientos).toHaveLength(movsCaja);
    expect(erp.datos.pagosProveedor).toHaveLength(0);
    // La posición no cambia: la plata sigue en bancos en USD.
    const total = (e: ErpSintetico): string => e.posicionTesoreria().kpis.find((k) => k.id === 'bancos_usd')!.valor.valor;
    expect(total(erp)).toBe(total(nuevoErp()));
    expect(erp.auditoria.at(-1)).toMatchObject({ tool: 'confirmar_transferencia_interna', usuario: operador.usuario });
  });

  it('repetir la clave no duplica los movimientos, y una propuesta confirmada no se confirma de nuevo', async () => {
    const erp = nuevoErp();
    const n0 = saldo(erp, NACION);
    const p = erp.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '100' }, operador);
    const primera = await erp.confirmar('transferencia_interna', args(p), operador);
    const repetida = await erp.confirmar('transferencia_interna', args(p), operador);
    expect(repetida).toMatchObject({ idempotente: true, resultado: primera.resultado });
    expect(erp.datos.transferenciasInternas).toHaveLength(1);
    expect(saldo(erp, NACION)).toBe(n0 - 10_000);
    await expect(erp.confirmar('transferencia_interna', args(p, {}, 'idk_tesoreria_otra'), operador)).rejects.toMatchObject({ codigo: 'PROPUESTA_YA_CONFIRMADA' });
    await expect(erp.confirmar('transferencia_interna', { ...args(p), confirmation_token: 'token-que-no-es-el-de-la-propuesta' }, operador)).rejects.toMatchObject({ codigo: 'TOKEN_INVALIDO' });
  });

  it('vuelve a verificar el saldo al confirmar: si bajó y ya no alcanza, rechaza', async () => {
    const erp = nuevoErp({ umbralTransferenciaInterna: 1_000_000_000 });
    const total = (saldo(erp, GALICIA) / 100).toFixed(2);
    const uno = erp.prepararTransferenciaInterna({ cuenta_origen_id: GALICIA, cuenta_destino_id: NACION, importe: total }, operador);
    const dos = erp.prepararTransferenciaInterna({ cuenta_origen_id: GALICIA, cuenta_destino_id: NACION, importe: total }, operador);
    await erp.confirmar('transferencia_interna', args(uno, {}, 'idk_ti_uno'), operador);
    expect(saldo(erp, GALICIA)).toBe(0);
    await expect(erp.confirmar('transferencia_interna', args(dos, {}, 'idk_ti_dos'), operador)).rejects.toMatchObject({ codigo: 'SALDO_INSUFICIENTE' });
    expect(erp.datos.transferenciasInternas).toHaveLength(1);
    expect(saldo(erp, GALICIA)).toBe(0);
  });

  it('una transferencia grande exige a un supervisor y nadie se autoriza a sí mismo', async () => {
    const erp = nuevoErp();
    const p = erp.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '6000' }, operador);
    await expect(erp.confirmar('transferencia_interna', args(p), operador)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    await expect(erp.confirmar('transferencia_interna', args(p, { autorizacion: { usuario: 'supervisor1', pin: 'mal' } }), operador)).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
    expect(erp.datos.transferenciasInternas).toHaveLength(0);
    const ok = await erp.confirmar('transferencia_interna', args(p, supervisor), operador);
    expect(ok.estado).toBe('confirmado');
    expect(erp.auditoria.at(-1)).toMatchObject({ tool: 'confirmar_transferencia_interna', autorizo: 'supervisor1' });
    const propia = nuevoErp({ autorizadores: { supervisor1: autorizadores.supervisor1 } });
    const q = propia.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '6000' }, contextoDe('supervisor', 'supervisor1'));
    await expect(propia.confirmar('transferencia_interna', args(q, supervisor), contextoDe('supervisor', 'supervisor1'))).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
  });

  it('una propuesta de otro tipo no se confirma como transferencia, ni un rol de lectura confirma', async () => {
    const erp = nuevoErp();
    const mov = erp.prepararMovimientoCaja({ tipo: 'egreso', concepto: 'Limpieza', importe: '10' }, operador);
    await expect(erp.confirmar('transferencia_interna', args(mov), operador)).rejects.toMatchObject({ codigo: 'PROPUESTA_NO_ENCONTRADA' });
    const p = erp.prepararTransferenciaInterna({ cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '10' }, operador);
    await expect(erp.confirmar('transferencia_interna', args(p), contextoDe('lectura'))).rejects.toMatchObject({ codigo: 'PERMISO_DENEGADO' });
  });
});

describe('por el servidor MCP y el agente', () => {
  it('el catálogo expone las lecturas y el par preparar/confirmar, valida el esquema y devuelve los errores del contrato', async () => {
    const { servidor } = crearServidorMcp();
    const { ClienteMcp } = await import('@agentic-erp/mcp-client');
    const c = await ClienteMcp.enMemoria(servidor);
    try {
      const nombres = (await c.listarTools()).map((t) => t.nombre);
      expect(nombres).toEqual(expect.arrayContaining(['listar_cuentas_bancarias', 'listar_movimientos_bancarios', 'conciliar_depositos', 'posicion_tesoreria', 'preparar_transferencia_interna', 'confirmar_transferencia_interna']));
      const sinImporte = await c.llamar('preparar_transferencia_interna', { cuenta_origen_id: NACION, cuenta_destino_id: GALICIA }, operador);
      expect(sinImporte.datos['codigo']).toBe('PARAMETRO_INVALIDO');
      const ok = await c.llamar('preparar_transferencia_interna', { cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '2000' }, operador);
      expect(ok.ok).toBe(true);
      expect(ok.datos['proposal_id']).toBeTruthy();
      const monedas = await c.llamar('preparar_transferencia_interna', { cuenta_origen_id: NACION, cuenta_destino_id: SANTANDER, importe: '500' }, operador);
      expect(monedas.datos['codigo']).toBe('MONEDAS_DISTINTAS');
      const prohibido = await c.llamar('preparar_transferencia_interna', { cuenta_origen_id: NACION, cuenta_destino_id: GALICIA, importe: '10' }, contextoDe('lectura'));
      expect(prohibido.datos['codigo']).toBe('PERMISO_DENEGADO');
      const concil = await c.llamar('conciliar_depositos', { desde: '2026-03-01', hasta: '2026-03-31' }, gerente);
      expect(concil.ok).toBe(true);
      expect((concil.datos['filas'] as unknown[]).length).toBe(2);
      const mala = await c.llamar('conciliar_depositos', { desde: 'marzo', hasta: HOY }, gerente);
      expect(mala.datos['codigo']).toBe('PARAMETRO_INVALIDO');
    } finally {
      await c.cerrar();
    }
  });

  it('el agente de tesorería usa tools que existen, no tiene ninguna confirmar_* y no pasa de 15', () => {
    const agente = REGISTRO_AGENTES.todos().find((a) => a.nombre === 'tesoreria')!;
    const existentes = new Set(TOOLS.map((t) => t.nombre));
    for (const t of agente.tools) expect(existentes.has(t), t).toBe(true);
    expect(agente.tools.some((t) => t.startsWith('confirmar_'))).toBe(false);
    expect(agente.tools.length).toBeLessThanOrEqual(15);
  });
});
