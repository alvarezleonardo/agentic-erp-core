import { describe, expect, it } from 'vitest';
import { ErpSintetico, HOY, PIN_SUPERVISOR_DE_PRUEBA, REGISTRO_AGENTES, TOOLS, contextoDe, crearServidorMcp, generarDatos, saldoDeFactura, type Factura } from '../src/index.js';

type Obj = Record<string, unknown>;
const operador = contextoDe('operador');
const nuevoErp = (opciones: ConstructorParameters<typeof ErpSintetico>[0] = {}): ErpSintetico => new ErpSintetico({ autorizadores: { supervisor1: { pin: PIN_SUPERVISOR_DE_PRUEBA, rol: 'supervisor' } }, ...opciones });
const cent = (d: unknown): number => Number(String((d as { monto: string }).monto).replace('.', ''));
const monto = (centavos: number): string => (centavos / 100).toFixed(2);
const args = (p: { proposal_id: string; confirmation_token: string }, extra: Obj = {}, clave = 'idk_cobro_0001'): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: clave, ...extra });
const supervisor = { autorizacion: { usuario: 'supervisor1', pin: PIN_SUPERVISOR_DE_PRUEBA } };

/** Facturas con saldo de un cliente, de la más vieja a la más nueva (el orden de imputación). */
const abiertas = (erp: ErpSintetico, cliente: string): Factura[] => erp.datos.facturas.filter((f) => f.cliente_id === cliente && saldoDeFactura(f) > 0).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.numero.localeCompare(b.numero));
const deuda = (erp: ErpSintetico, cliente: string): number => abiertas(erp, cliente).reduce((s, f) => s + saldoDeFactura(f), 0);

describe('datos de cobranzas', () => {
  it('reutilizan clientes y facturas; no hay cobros registrados de entrada y los datos son deterministas', () => {
    const a = generarDatos();
    expect(a.cobranzas).toEqual([]);
    expect(a.facturas).toEqual(generarDatos().facturas);
  });

  it('el moroso lo debe todo vencido y solo dos clientes tienen deuda vencida de más de 60 días', () => {
    const erp = nuevoErp();
    const moroso = abiertas(erp, 'cli_05');
    expect(moroso.length).toBeGreaterThan(0);
    expect(moroso.some((f) => f.vencimiento < HOY)).toBe(true);
    const viejos = erp.listarDeudores({ antiguedad_minima: 60 }).filas.map((f) => f['cliente_id']);
    expect(viejos).toEqual(['cli_05', 'cli_07']);
  });
});

describe('estado de cuenta', () => {
  const campo = (d: { campos: { etiqueta: string; valor: string }[] }, etiqueta: string): string => d.campos.find((c) => c.etiqueta === etiqueta)?.valor ?? '';

  it('saldo, vencido y a vencer salen de las facturas, y cada factura con saldo figura en la ficha', () => {
    const erp = nuevoErp();
    const d = erp.estadoCuentaCliente({ cliente_id: 'cli_03' });
    const fs = abiertas(erp, 'cli_03');
    const vencido = fs.filter((f) => f.vencimiento < HOY).reduce((s, f) => s + saldoDeFactura(f), 0);
    expect(d.cliente_id).toBe('cli_03');
    expect(campo(d, 'Saldo pendiente')).toBe(`${monto(deuda(erp, 'cli_03'))} USD`);
    expect(campo(d, 'Vencido')).toBe(`${monto(vencido)} USD`);
    expect(campo(d, 'A vencer')).toBe(`${monto(deuda(erp, 'cli_03') - vencido)} USD`);
    expect(campo(d, 'Crédito disponible')).toBe(`${monto(2_500_000 - deuda(erp, 'cli_03'))} USD`);
    expect(d.campos.filter((c) => c.etiqueta.startsWith('Factura ')).length).toBe(fs.length);
  });

  it('el cliente que supera su límite figura como excedido y uno de contado no tiene límite', () => {
    const erp = nuevoErp();
    expect(campo(erp.estadoCuentaCliente({ cliente_id: 'cli_07' }), 'Crédito disponible')).toMatch(/^Ninguno: excede el límite en /);
    const contado = erp.estadoCuentaCliente({ cliente_id: 'cli_04' });
    expect(campo(contado, 'Saldo pendiente')).toBe('0.00 USD');
    expect(campo(contado, 'Límite de crédito')).toMatch(/contado/);
  });

  it('un cliente inexistente es un error', () => {
    expect(() => nuevoErp().estadoCuentaCliente({ cliente_id: 'cli_99' })).toThrow(/No existe el cliente/);
  });
});

describe('deudores', () => {
  it('lista solo clientes con saldo vencido, por saldo vencido de mayor a menor, y los tramos suman el vencido', () => {
    const erp = nuevoErp();
    const t = erp.listarDeudores({});
    const filas = t.filas;
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.map((f) => f['cliente_id'])).not.toContain('cli_10'); // nada vencido
    expect(filas.map((f) => f['cliente_id'])).not.toContain('cli_04'); // contado
    expect(filas[0]?.['cliente_id']).toBe('cli_05');
    const vencidos = filas.map((f) => cent(f['saldo_vencido']));
    expect(vencidos).toEqual([...vencidos].sort((a, b) => b - a));
    for (const f of filas) expect(cent(f['tramo_0_30']) + cent(f['tramo_31_60']) + cent(f['tramo_61_90']) + cent(f['tramo_mas_90'])).toBe(cent(f['saldo_vencido']));
  });

  it('la antigüedad se cuenta desde la emisión; antiguedad_minima descarta lo más nuevo', () => {
    const erp = nuevoErp();
    const todos = erp.listarDeudores({}).filas.find((f) => f['cliente_id'] === 'cli_05')!;
    const viejos = erp.listarDeudores({ antiguedad_minima: 60 }).filas.find((f) => f['cliente_id'] === 'cli_05')!;
    expect(cent(viejos['saldo_vencido'])).toBeLessThan(cent(todos['saldo_vencido']));
    expect(cent(viejos['tramo_0_30'])).toBe(0);
    expect(cent(viejos['tramo_31_60'])).toBe(0);
    expect(cent(viejos['tramo_61_90'])).toBe(cent(viejos['saldo_vencido']));
    expect(Number(viejos['antiguedad_maxima'])).toBeGreaterThan(60);
  });

  it('ordena por antigüedad o por nombre, respeta el límite y valida los parámetros', () => {
    const erp = nuevoErp();
    const nombres = erp.listarDeudores({ orden: 'nombre' }).filas.map((f) => String(f['cliente']));
    expect(nombres).toEqual([...nombres].sort((a, b) => a.localeCompare(b, 'es')));
    const porEdad = erp.listarDeudores({ orden: 'antiguedad' }).filas.map((f) => Number(f['antiguedad_maxima']));
    expect(porEdad).toEqual([...porEdad].sort((a, b) => b - a));
    const uno = erp.listarDeudores({ limite: 1 });
    expect(uno.filas).toHaveLength(1);
    expect(uno.total_filas).toBeGreaterThan(1);
    expect(() => erp.listarDeudores({ orden: 'edad' })).toThrow(/orden/);
    expect(() => erp.listarDeudores({ antiguedad_minima: -1 })).toThrow(/antiguedad_minima/);
  });
});

describe('preparar cobranza', () => {
  it('reparte el cobro entre las facturas con saldo, de la más vieja a la más nueva, y calcula lo que queda', () => {
    const erp = nuevoErp();
    const fs = abiertas(erp, 'cli_05');
    const primera = saldoDeFactura(fs[0]!);
    const importe = primera + 100; // cubre la primera y 1.00 de la segunda
    const p = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'transferencia', importe: monto(importe) }, operador);
    expect(cent(p.total)).toBe(importe);
    expect(p.lineas).toHaveLength(2);
    expect(cent(p.lineas![0]!.importe)).toBe(primera);
    expect(p.lineas![0]!.descripcion).toContain(fs[0]!.numero);
    expect(p.lineas![0]!.descripcion).toMatch(/queda cobrada/);
    expect(cent(p.lineas![1]!.importe)).toBe(100);
    expect(p.lineas![1]!.descripcion).toContain(fs[1]!.numero);
    expect(p.resumen?.find((r) => r.etiqueta === 'Deuda después del cobro')?.valor).toBe(`${monto(deuda(erp, 'cli_05') - importe)} USD`);
    expect(p.resumen?.find((r) => r.etiqueta === 'Facturas que quedan cobradas')?.valor).toBe('1 de 2');
    // Preparar no cambia nada.
    expect(deuda(erp, 'cli_05')).toBe(fs.reduce((s, f) => s + saldoDeFactura(f), 0));
  });

  it('acepta el importe tal como lo escribe una persona y puede saldar toda la deuda', () => {
    const erp = nuevoErp();
    expect(cent(erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'cheque', importe: '1500,50' }, operador).total)).toBe(150_050);
    const todo = erp.prepararCobranza({ cliente_id: 'cli_10', medio: 'cheque', importe: monto(deuda(erp, 'cli_10')) }, operador);
    expect(todo.resumen?.find((r) => r.etiqueta === 'Deuda después del cobro')?.valor).toBe('0.00 USD');
    expect(todo.lineas).toHaveLength(abiertas(erp, 'cli_10').length);
  });

  it('rechaza un importe mayor a la deuda (no hay anticipos), un cliente sin deuda y datos inválidos', () => {
    const erp = nuevoErp();
    expect(() => erp.prepararCobranza({ cliente_id: 'cli_10', medio: 'efectivo', importe: monto(deuda(erp, 'cli_10') + 1) }, operador)).toThrow(/no puede superar lo que/);
    expect(() => erp.prepararCobranza({ cliente_id: 'cli_04', medio: 'efectivo', importe: '10' }, operador)).toThrow(/no tiene facturas con saldo/);
    expect(() => erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'tarjeta', importe: '10' }, operador)).toThrow(/medio/);
    expect(() => erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'efectivo', importe: '0' }, operador)).toThrow(/mayor que cero/);
    expect(() => erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'efectivo', importe: 'mucho' }, operador)).toThrow(/importe/);
    expect(() => erp.prepararCobranza({ cliente_id: 'cli_99', medio: 'efectivo', importe: '10' }, operador)).toThrow(/No existe el cliente/);
  });

  it('el servidor vuelve a verificar el rol: lectura no puede preparar', () => {
    expect(() => nuevoErp().prepararCobranza({ cliente_id: 'cli_05', medio: 'efectivo', importe: '10' }, contextoDe('lectura'))).toThrow(/rol/i);
  });

  it('el step-up depende del umbral, que se puede configurar', () => {
    const erp = nuevoErp();
    expect(erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'cheque', importe: '1500' }, operador).step_up).toBeUndefined();
    const g = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'cheque', importe: '8000' }, operador);
    expect(g.step_up).toBe('supervisor');
    expect(g.advertencias).toEqual(['Las cobranzas de 5000.00 o más necesitan la confirmación de un supervisor.']);
    const estricto = nuevoErp({ umbralCobranza: 1_000 });
    expect(estricto.prepararCobranza({ cliente_id: 'cli_05', medio: 'cheque', importe: '10' }, operador).advertencias).toEqual(['Las cobranzas de 10.00 o más necesitan la confirmación de un supervisor.']);
  });

  it('avisa que un cobro en efectivo ingresa también a la caja', () => {
    const erp = nuevoErp();
    expect(erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'efectivo', importe: '100' }, operador).advertencias?.[0]).toMatch(/caja/);
    expect(erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'transferencia', importe: '100' }, operador).advertencias).toBeUndefined();
  });
});

describe('confirmar cobranza', () => {
  it('las facturas cambian de estado según lo imputado y la deuda baja exactamente lo cobrado', async () => {
    const erp = nuevoErp({ umbralCobranza: 1_000_000_000 });
    const fs = abiertas(erp, 'cli_05');
    const [a, b, c] = [fs[0]!, fs[1]!, fs[2]!];
    const antes = deuda(erp, 'cli_05');
    const importe = saldoDeFactura(a) + saldoDeFactura(b) + 100;
    const p = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'transferencia', importe: monto(importe) }, operador);
    const salida = await erp.confirmar('cobranza', args(p), operador);
    expect(salida).toMatchObject({ estado: 'confirmado', idempotente: false, resultado: { cliente_id: 'cli_05' } });
    expect(a.estado).toBe('cobrada');
    expect(b.estado).toBe('cobrada');
    expect(saldoDeFactura(a)).toBe(0);
    expect(c.estado === 'parcialmente_cobrada' || c.estado === 'cobrada').toBe(true); // la tercera recibió 1.00
    expect(deuda(erp, 'cli_05')).toBe(antes - importe);
    expect((salida.resultado as Obj)['facturas']).toEqual([a, b, c].map((f) => ({ factura_id: f.id, estado: f.estado })));
    expect(cent((salida.resultado as Obj)['saldo_cliente'])).toBe(antes - importe);
  });

  it('una factura emitida que cobra solo una parte queda parcialmente cobrada', async () => {
    const erp = nuevoErp({ umbralCobranza: 1_000_000_000 });
    const fs = abiertas(erp, 'cli_05');
    const i = fs.findIndex((x) => x.estado === 'emitida');
    const previas = fs.slice(0, i);
    const f = fs[i]!;
    const p = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'cheque', importe: monto(previas.reduce((s, x) => s + saldoDeFactura(x), 0) + 100) }, operador);
    await erp.confirmar('cobranza', args(p), operador);
    for (const x of previas) expect(x.estado).toBe('cobrada');
    expect(f.estado).toBe('parcialmente_cobrada');
    expect(f.cobrado).toBe(100);
  });

  it('registra el cobro con sus imputaciones y se lista en listar_cobranzas', async () => {
    const erp = nuevoErp();
    const primera = abiertas(erp, 'cli_05')[0]!;
    const p = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'transferencia', importe: '1500' }, operador);
    await erp.confirmar('cobranza', args(p), operador);
    expect(erp.datos.cobranzas).toHaveLength(1);
    const cobro = erp.datos.cobranzas[0]!;
    expect(cobro).toMatchObject({ cliente_id: 'cli_05', medio: 'transferencia', importe: 150_000, fecha: HOY });
    expect(cobro.imputaciones.reduce((s, i) => s + i.importe, 0)).toBe(150_000);
    expect(cobro.imputaciones[0]?.factura_id).toBe(primera.id);
    const lista = erp.listarCobranzas({ cliente_id: 'cli_05' });
    expect(lista.filas).toHaveLength(1);
    expect(cent(lista.filas[0]!['importe'])).toBe(150_000);
    expect(erp.listarCobranzas({ cliente_id: 'cli_07' }).filas).toHaveLength(0);
    expect(erp.listarCobranzas({ desde: HOY, hasta: HOY }).filas).toHaveLength(1);
    expect(() => erp.listarCobranzas({ desde: HOY, hasta: '2026-03-01' })).toThrow(/posterior/);
  });

  it('en efectivo deja también el ingreso en caja; con otro medio no toca la caja', async () => {
    const erp = nuevoErp();
    const movs = erp.datos.movimientos.length;
    const ingresosAntes = cent((erp.listarMovimientosCaja(HOY).filas.filter((m) => m['tipo'] === 'ingreso').reduce((s, m) => ({ monto: monto(cent(s) + cent(m['importe'])) }), { monto: '0.00' })));
    const cheque = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'cheque', importe: '300' }, operador);
    await erp.confirmar('cobranza', args(cheque, {}, 'idk_cobro_cheque'), operador);
    expect(erp.datos.movimientos).toHaveLength(movs);
    const efectivo = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'efectivo', importe: '250,75' }, operador);
    const salida = await erp.confirmar('cobranza', args(efectivo, {}, 'idk_cobro_efectivo'), operador);
    expect(erp.datos.movimientos).toHaveLength(movs + 1);
    const mov = erp.datos.movimientos.at(-1)!;
    expect(mov).toMatchObject({ tipo: 'ingreso', concepto: 'Cobranza Colegio San Martín', importe: 25_075, fecha: HOY });
    expect((salida.resultado as Obj)['movimiento_caja_id']).toBe(mov.id);
    const ingresosDespues = erp.listarMovimientosCaja(HOY).filas.filter((m) => m['tipo'] === 'ingreso').reduce((s, m) => s + cent(m['importe']), 0);
    expect(ingresosDespues - ingresosAntes).toBe(25_075);
  });

  it('repetir la clave no duplica el cobro ni el ingreso de caja, y una propuesta confirmada no se confirma de nuevo', async () => {
    const erp = nuevoErp();
    const antes = deuda(erp, 'cli_05');
    const p = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'efectivo', importe: '400' }, operador);
    const movs = erp.datos.movimientos.length;
    const primera = await erp.confirmar('cobranza', args(p), operador);
    const repetida = await erp.confirmar('cobranza', args(p), operador);
    expect(repetida).toMatchObject({ idempotente: true, resultado: primera.resultado });
    expect(erp.datos.cobranzas).toHaveLength(1);
    expect(erp.datos.movimientos).toHaveLength(movs + 1);
    expect(deuda(erp, 'cli_05')).toBe(antes - 40_000);
    await expect(erp.confirmar('cobranza', args(p, {}, 'idk_cobro_otra'), operador)).rejects.toMatchObject({ codigo: 'PROPUESTA_YA_CONFIRMADA' });
  });

  it('vuelve a verificar la deuda al confirmar: si cambió y ya no alcanza, rechaza', async () => {
    const erp = nuevoErp();
    const total = deuda(erp, 'cli_10');
    const mitad = Math.ceil(total / 2) + 100;
    const uno = erp.prepararCobranza({ cliente_id: 'cli_10', medio: 'cheque', importe: monto(mitad) }, operador);
    const dos = erp.prepararCobranza({ cliente_id: 'cli_10', medio: 'cheque', importe: monto(mitad) }, operador);
    await erp.confirmar('cobranza', args(uno, {}, 'idk_cobro_uno'), operador);
    await expect(erp.confirmar('cobranza', args(dos, {}, 'idk_cobro_dos'), operador)).rejects.toMatchObject({ codigo: 'IMPORTE_EXCEDE_DEUDA' });
    expect(erp.datos.cobranzas).toHaveLength(1);
    expect(deuda(erp, 'cli_10')).toBe(total - mitad);
  });

  it('un cobro de monto alto exige un supervisor; sin él no pasa y con él se registra', async () => {
    const erp = nuevoErp();
    const p = erp.prepararCobranza({ cliente_id: 'cli_05', medio: 'cheque', importe: '8000' }, operador);
    await expect(erp.confirmar('cobranza', args(p), operador)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    expect(erp.datos.cobranzas).toHaveLength(0);
    await expect(erp.confirmar('cobranza', args(p, { autorizacion: { usuario: 'supervisor1', pin: 'mal' } }), operador)).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
    const ok = await erp.confirmar('cobranza', args(p, supervisor), operador);
    expect(ok.estado).toBe('confirmado');
    expect(erp.auditoria.at(-1)).toMatchObject({ tool: 'confirmar_cobranza', autorizo: 'supervisor1' });
    expect(erp.datos.cobranzas[0]?.importe).toBe(800_000);
  });

  it('una propuesta de otro tipo no se confirma como cobranza', async () => {
    const erp = nuevoErp();
    const nc = erp.prepararNotaCredito({ factura_id: abiertas(erp, 'cli_05')[0]!.id, motivo: 'Error' }, operador);
    await expect(erp.confirmar('cobranza', args(nc), operador)).rejects.toMatchObject({ codigo: 'PROPUESTA_NO_ENCONTRADA' });
  });
});

describe('por el servidor MCP y el agente', () => {
  it('el catálogo expone las lecturas y el par preparar/confirmar, y valida el esquema', async () => {
    const { servidor } = crearServidorMcp();
    const { ClienteMcp } = await import('@agentic-erp/mcp-client');
    const c = await ClienteMcp.enMemoria(servidor);
    try {
      const nombres = (await c.listarTools()).map((t) => t.nombre);
      expect(nombres).toEqual(expect.arrayContaining(['estado_cuenta_cliente', 'listar_deudores', 'listar_cobranzas', 'preparar_cobranza', 'confirmar_cobranza']));
      const sinMedio = await c.llamar('preparar_cobranza', { cliente_id: 'cli_05', importe: '10' }, operador);
      expect(sinMedio.ok).toBe(false);
      expect(sinMedio.datos['codigo']).toBe('PARAMETRO_INVALIDO');
      const ok = await c.llamar('preparar_cobranza', { cliente_id: 'cli_05', medio: 'transferencia', importe: '1500' }, operador);
      expect(ok.ok).toBe(true);
      expect(ok.datos['proposal_id']).toBeTruthy();
      const exceso = await c.llamar('preparar_cobranza', { cliente_id: 'cli_10', medio: 'transferencia', importe: '999999' }, operador);
      expect(exceso.datos['codigo']).toBe('IMPORTE_EXCEDE_DEUDA');
      const prohibido = await c.llamar('preparar_cobranza', { cliente_id: 'cli_05', medio: 'transferencia', importe: '10' }, contextoDe('lectura'));
      expect(prohibido.datos['codigo']).toBe('PERMISO_DENEGADO');
    } finally {
      await c.cerrar();
    }
  });

  it('el agente de cobranzas usa tools que existen, no tiene ninguna confirmar_* y no pasa de 15', () => {
    const agente = REGISTRO_AGENTES.todos().find((a) => a.nombre === 'cobranzas')!;
    const existentes = new Set(TOOLS.map((t) => t.nombre));
    for (const t of agente.tools) expect(existentes.has(t), t).toBe(true);
    expect(agente.tools.some((t) => t.startsWith('confirmar_'))).toBe(false);
    expect(agente.tools.length).toBeLessThanOrEqual(15);
  });
});
