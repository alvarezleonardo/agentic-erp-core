import { diaDeSemana, rango, sumarDias } from './fechas.js';

/** «Hoy» del ejemplo. Fijo, para que los datos y los evals sean reproducibles. */
export const HOY = '2026-03-31';
export const INICIO_DATOS = '2026-01-01';
export const MONEDA = 'USD';
const SEMILLA = 20260331;

/** Fechas con anomalías sembradas (las dos que tiene que encontrar `detectar_anomalias`). */
export const ANOMALIA_VENTAS = '2026-03-24';
export const ANOMALIA_CAJA = '2026-03-28';
const FALTANTE_CAJA_CENTAVOS = 18_450;
const FACTOR_CAIDA_VENTAS = 0.35;
const FONDO_FIJO_CENTAVOS = 50_000;

export interface Proveedor {
  id: string;
  nombre: string;
  plazo_dias: number;
}

export interface Articulo {
  id: string;
  nombre: string;
  categoria: string;
  precio: number;
  costo: number;
  proveedor_id: string;
  existencia: number;
  minimo: number;
  /** Unidades vendidas por día en promedio (parámetro del generador). */
  demanda: number;
}

export interface Venta {
  fecha: string;
  articulo_id: string;
  canal: 'tienda' | 'online';
  unidades: number;
  /** Centavos. */
  ingresos: number;
  costo: number;
}

export interface LineaOrden {
  articulo_id: string;
  cantidad: number;
  costo_unitario: number;
}

export interface OrdenCompra {
  id: string;
  proveedor_id: string;
  fecha: string;
  estado: 'pendiente' | 'recibida';
  lineas: LineaOrden[];
}

export interface MovimientoCaja {
  id: string;
  fecha: string;
  tipo: 'ingreso' | 'egreso';
  concepto: string;
  importe: number;
}

export interface Arqueo {
  fecha: string;
  contado: number;
}

export interface Cliente {
  id: string;
  nombre: string;
  condicion_pago: 'contado' | 'cuenta_corriente';
  /** Centavos. Cero para los clientes de contado. */
  limite_credito: number;
  /** Letra de los comprobantes que se le emiten: A (responsable inscripto) o B. */
  tipo_comprobante: 'A' | 'B';
  plazo_dias: number;
}

export type EstadoFactura = 'emitida' | 'anulada' | 'parcialmente_cobrada' | 'cobrada';

/**
 * Factura de venta. El saldo pendiente no se guarda: es `importe - cobrado - acreditado` (ver `saldoDeFactura`), así
 * que cobranzas solo suma a `cobrado` y facturación solo suma a `acreditado`. `estado` se mantiene con `estadoDeFactura`.
 */
export interface Factura {
  id: string;
  /** Punto de venta y número, por ejemplo 0001-00001234. La numeración es correlativa por letra. */
  numero: string;
  tipo: 'A' | 'B';
  cliente_id: string;
  fecha: string;
  vencimiento: string;
  /** Centavos. */
  importe: number;
  /** Centavos cobrados hasta hoy. */
  cobrado: number;
  /** Centavos acreditados por notas de crédito. */
  acreditado: number;
  estado: EstadoFactura;
}

export type MedioCobro = 'efectivo' | 'transferencia' | 'cheque';

/** Parte de un cobro aplicada a una factura. */
export interface ImputacionCobro {
  factura_id: string;
  /** Centavos. */
  importe: number;
}

/**
 * Cobro registrado a un cliente. Se imputa a las facturas con saldo, de la más vieja a la más nueva. Los cobros
 * anteriores a este registro no tienen detalle: quedan solo en el `cobrado` de cada factura.
 */
export interface Cobranza {
  id: string;
  /** Número de recibo, por ejemplo 0001-00000001. */
  numero: string;
  cliente_id: string;
  fecha: string;
  medio: MedioCobro;
  /** Centavos. */
  importe: number;
  imputaciones: ImputacionCobro[];
}

export interface NotaCredito {
  id: string;
  numero: string;
  tipo: 'A' | 'B';
  factura_id: string;
  fecha: string;
  /** Centavos. */
  importe: number;
  motivo: string;
}

/** Saldo pendiente de una factura, en centavos. */
export const saldoDeFactura = (f: Pick<Factura, 'importe' | 'cobrado' | 'acreditado'>): number => f.importe - f.cobrado - f.acreditado;

/**
 * Estado que corresponde a una factura según sus importes. Una factura sin cobros cuyo saldo se acreditó por completo
 * queda anulada; si ya tenía cobros, queda cobrada.
 */
export function estadoDeFactura(f: Pick<Factura, 'importe' | 'cobrado' | 'acreditado'>): EstadoFactura {
  if (saldoDeFactura(f) > 0) return f.cobrado > 0 ? 'parcialmente_cobrada' : 'emitida';
  return f.cobrado === 0 ? 'anulada' : 'cobrada';
}

export type EstadoFacturaProveedor = 'pendiente' | 'parcialmente_pagada' | 'pagada';

/**
 * Factura de un proveedor (cuenta a pagar). Igual que la factura de venta, el saldo no se guarda: es `importe - pagado`
 * (ver `saldoDeFacturaProveedor`), así que pagos solo suma a `pagado`. `estado` se mantiene con `estadoDeFacturaProveedor`.
 */
export interface FacturaProveedor {
  id: string;
  /** Número del comprobante tal como lo emitió el proveedor, por ejemplo 0003-00004388. */
  numero: string;
  proveedor_id: string;
  /** Orden de compra recibida a la que corresponde, si se la puede vincular. */
  orden_id?: string;
  fecha: string;
  vencimiento: string;
  /** Centavos. */
  importe: number;
  /** Centavos pagados hasta hoy. */
  pagado: number;
  estado: EstadoFacturaProveedor;
}

export type MedioPago = 'efectivo' | 'transferencia';

/** `pagado`: salió de la caja. `pendiente_debito`: transferencia ordenada, a la espera del débito bancario (tesorería lo informa en la posición; este ejemplo no registra el débito). */
export type EstadoBancario = 'pagado' | 'pendiente_debito';

/** Parte de un pago aplicada a una factura de proveedor. */
export interface ImputacionPago {
  factura_id: string;
  /** Centavos. */
  importe: number;
}

/** Pago registrado a un proveedor, imputado a sus facturas de la que vence primero a la que vence último. */
export interface PagoProveedor {
  id: string;
  /** Número de la orden de pago, por ejemplo OP-0001. */
  numero: string;
  proveedor_id: string;
  fecha: string;
  medio: MedioPago;
  /** Centavos. */
  importe: number;
  estado_bancario: EstadoBancario;
  imputaciones: ImputacionPago[];
}

/** Saldo pendiente de una factura de proveedor, en centavos. */
export const saldoDeFacturaProveedor = (f: Pick<FacturaProveedor, 'importe' | 'pagado'>): number => f.importe - f.pagado;

export function estadoDeFacturaProveedor(f: Pick<FacturaProveedor, 'importe' | 'pagado'>): EstadoFacturaProveedor {
  if (saldoDeFacturaProveedor(f) <= 0) return 'pagada';
  return f.pagado > 0 ? 'parcialmente_pagada' : 'pendiente';
}

export type MonedaCuenta = 'USD' | 'ARS';

/** Cuenta bancaria propia. El saldo no se guarda: es `saldo_inicial` más los movimientos (ver `saldoDeCuenta`). */
export interface CuentaBancaria {
  id: string;
  nombre: string;
  moneda: MonedaCuenta;
  /** Centavos de la moneda de la cuenta, al 01/01/2026. */
  saldo_inicial: number;
}

export type TipoMovimientoBancario = 'deposito_caja' | 'acreditacion_cliente' | 'debito_proveedor' | 'comision' | 'impuesto' | 'transferencia_interna';

/** Movimiento del extracto bancario. El importe es siempre positivo; el sentido dice si suma (`credito`) o resta (`debito`). */
export interface MovimientoBancario {
  id: string;
  cuenta_id: string;
  fecha: string;
  sentido: 'credito' | 'debito';
  tipo: TipoMovimientoBancario;
  concepto: string;
  /** Centavos de la moneda de la cuenta. */
  importe: number;
}

/** Transferencia entre dos cuentas propias de la misma moneda. Deja dos movimientos bancarios: un débito y un crédito. */
export interface TransferenciaInterna {
  id: string;
  /** Número, por ejemplo TI-0001. */
  numero: string;
  fecha: string;
  origen_id: string;
  destino_id: string;
  /** Centavos de la moneda de las dos cuentas. */
  importe: number;
}

/** Saldo de una cuenta, en centavos de su moneda. */
export const saldoDeCuenta = (cuenta: CuentaBancaria, movimientos: readonly MovimientoBancario[]): number =>
  cuenta.saldo_inicial + movimientos.filter((m) => m.cuenta_id === cuenta.id).reduce((s, m) => s + (m.sentido === 'credito' ? m.importe : -m.importe), 0);

export interface DatosErp {
  proveedores: Proveedor[];
  articulos: Articulo[];
  ventas: Venta[];
  ordenes: OrdenCompra[];
  movimientos: MovimientoCaja[];
  arqueos: Arqueo[];
  clientes: Cliente[];
  facturas: Factura[];
  notasCredito: NotaCredito[];
  /** Cobros registrados con el ERP. Arranca vacío: los cobros previos están en `Factura.cobrado`. */
  cobranzas: Cobranza[];
  /** Cuentas a pagar: facturas de proveedor, con parte ya pagada antes de este registro. */
  facturasProveedor: FacturaProveedor[];
  /** Pagos registrados con el ERP. Arranca vacío: los pagos anteriores están en `FacturaProveedor.pagado`. */
  pagosProveedor: PagoProveedor[];
  /** Cuentas bancarias propias (tesorería). */
  cuentasBancarias: CuentaBancaria[];
  /** Extracto de las cuentas desde el 01/01/2026 hasta hoy (ver `generarTesoreria`). */
  movimientosBancarios: MovimientoBancario[];
  /** Transferencias internas registradas con el ERP. Arranca vacío. */
  transferenciasInternas: TransferenciaInterna[];
}

/** Generador pseudoaleatorio determinista (mulberry32). */
export function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROVEEDORES: Proveedor[] = [
  { id: 'prv_01', nombre: 'Aurora Distribuciones', plazo_dias: 7 },
  { id: 'prv_02', nombre: 'Tecnoparts Mayorista', plazo_dias: 10 },
  { id: 'prv_03', nombre: 'Papelera Central', plazo_dias: 5 },
  { id: 'prv_04', nombre: 'Logística Andina', plazo_dias: 14 },
  // Dos homónimos a propósito (área pagos): «pagale a Gómez» es ambiguo y el agente pregunta, no elige. No proveen artículos.
  { id: 'prv_05', nombre: 'Gómez Insumos SA', plazo_dias: 15 },
  { id: 'prv_06', nombre: 'Gómez, Ricardo', plazo_dias: 7 },
];

// Importes en centavos. Tres artículos quedan bajo el mínimo a propósito (el 004 y el 007 con stock casi nulo).
const ARTICULOS: Articulo[] = [
  { id: 'art_001', nombre: 'Silla ergonómica', categoria: 'Mobiliario', precio: 14_900, costo: 8_200, proveedor_id: 'prv_01', existencia: 24, minimo: 8, demanda: 1.6 },
  { id: 'art_002', nombre: 'Escritorio ajustable', categoria: 'Mobiliario', precio: 32_900, costo: 19_500, proveedor_id: 'prv_01', existencia: 9, minimo: 4, demanda: 0.9 },
  { id: 'art_003', nombre: 'Monitor 24 pulgadas', categoria: 'Tecnología', precio: 18_900, costo: 12_400, proveedor_id: 'prv_02', existencia: 31, minimo: 10, demanda: 2.4 },
  { id: 'art_004', nombre: 'Teclado mecánico', categoria: 'Tecnología', precio: 8_900, costo: 4_700, proveedor_id: 'prv_02', existencia: 2, minimo: 10, demanda: 3.1 },
  { id: 'art_005', nombre: 'Mouse inalámbrico', categoria: 'Tecnología', precio: 2_900, costo: 1_300, proveedor_id: 'prv_02', existencia: 58, minimo: 20, demanda: 5.2 },
  { id: 'art_006', nombre: 'Auriculares con micrófono', categoria: 'Tecnología', precio: 6_500, costo: 3_600, proveedor_id: 'prv_02', existencia: 27, minimo: 12, demanda: 2.7 },
  { id: 'art_007', nombre: 'Webcam HD', categoria: 'Tecnología', precio: 5_400, costo: 2_900, proveedor_id: 'prv_02', existencia: 0, minimo: 6, demanda: 1.4 },
  { id: 'art_008', nombre: 'Lámpara LED de escritorio', categoria: 'Mobiliario', precio: 3_900, costo: 1_800, proveedor_id: 'prv_01', existencia: 40, minimo: 12, demanda: 2.0 },
  { id: 'art_009', nombre: 'Cuaderno A5 tapa dura', categoria: 'Papelería', precio: 650, costo: 240, proveedor_id: 'prv_03', existencia: 210, minimo: 80, demanda: 9.5 },
  { id: 'art_010', nombre: 'Set de bolígrafos x12', categoria: 'Papelería', precio: 900, costo: 380, proveedor_id: 'prv_03', existencia: 5, minimo: 25, demanda: 6.8 },
  { id: 'art_011', nombre: 'Mochila urbana', categoria: 'Accesorios', precio: 4_500, costo: 2_300, proveedor_id: 'prv_04', existencia: 36, minimo: 10, demanda: 1.9 },
  { id: 'art_012', nombre: 'Soporte para notebook', categoria: 'Accesorios', precio: 2_700, costo: 1_100, proveedor_id: 'prv_04', existencia: 44, minimo: 12, demanda: 2.2 },
];

// Más venta entre semana que el fin de semana (0 = domingo).
const FACTOR_DIA = [0.6, 1.0, 1.05, 1.0, 1.05, 1.2, 0.85] as const;

/**
 * Genera el ERP sintético. Es una función pura de la semilla: mismos datos en cada corrida. Siembra dos anomalías:
 * una caída de ventas el martes 24/03 y un faltante en el arqueo de caja del sábado 28/03.
 */
export function generarDatos(): DatosErp {
  const rng = mulberry32(SEMILLA);
  const articulos = ARTICULOS.map((a) => ({ ...a }));
  const ventas: Venta[] = [];
  const dias = rango(INICIO_DATOS, HOY);

  for (const fecha of dias) {
    for (const a of articulos) {
      // El generador se consume SIEMPRE igual para que cambiar un parámetro no desordene el resto de los datos.
      const ruido = 0.7 + 0.6 * rng();
      let unidades = a.demanda * (FACTOR_DIA[diaDeSemana(fecha)] ?? 1) * ruido;
      if (fecha === ANOMALIA_VENTAS) unidades *= FACTOR_CAIDA_VENTAS;
      const total = Math.round(unidades);
      const online = Math.round(total * 0.45);
      for (const [canal, n] of [['tienda', total - online], ['online', online]] as const) {
        if (n > 0) ventas.push({ fecha, articulo_id: a.id, canal, unidades: n, ingresos: a.precio * n, costo: a.costo * n });
      }
    }
  }

  const ordenes: OrdenCompra[] = [
    { id: 'oc_0001', proveedor_id: 'prv_01', fecha: '2026-01-12', estado: 'recibida', lineas: [{ articulo_id: 'art_001', cantidad: 20, costo_unitario: 8_200 }, { articulo_id: 'art_002', cantidad: 6, costo_unitario: 19_500 }] },
    { id: 'oc_0002', proveedor_id: 'prv_02', fecha: '2026-01-26', estado: 'recibida', lineas: [{ articulo_id: 'art_003', cantidad: 25, costo_unitario: 12_400 }, { articulo_id: 'art_005', cantidad: 60, costo_unitario: 1_300 }] },
    { id: 'oc_0003', proveedor_id: 'prv_03', fecha: '2026-02-09', estado: 'recibida', lineas: [{ articulo_id: 'art_009', cantidad: 200, costo_unitario: 240 }, { articulo_id: 'art_010', cantidad: 80, costo_unitario: 380 }] },
    { id: 'oc_0004', proveedor_id: 'prv_04', fecha: '2026-02-23', estado: 'recibida', lineas: [{ articulo_id: 'art_011', cantidad: 30, costo_unitario: 2_300 }] },
    { id: 'oc_0005', proveedor_id: 'prv_02', fecha: '2026-03-20', estado: 'pendiente', lineas: [{ articulo_id: 'art_006', cantidad: 24, costo_unitario: 3_600 }] },
  ];

  // Caja: ventas en efectivo (40 % de la tienda), un gasto menor por día y un depósito que deja el fondo fijo.
  const movimientos: MovimientoCaja[] = [];
  const arqueos: Arqueo[] = [];
  let apertura = FONDO_FIJO_CENTAVOS;
  let n = 0;
  for (const fecha of dias) {
    const efectivo = Math.round(ventas.filter((v) => v.fecha === fecha && v.canal === 'tienda').reduce((s, v) => s + v.ingresos, 0) * 0.4);
    const gasto = 2_000 + Math.round(rng() * 6_000);
    const ruidoCaja = rng() < 0.15 ? Math.round((rng() - 0.5) * 100) : 0;
    const ingresoId = `mov_${String(++n).padStart(4, '0')}`;
    const gastoId = `mov_${String(++n).padStart(4, '0')}`;
    movimientos.push({ id: ingresoId, fecha, tipo: 'ingreso', concepto: 'Ventas en efectivo', importe: efectivo });
    movimientos.push({ id: gastoId, fecha, tipo: 'egreso', concepto: 'Gastos menores', importe: gasto });
    if (fecha === HOY) break; // el día de hoy sigue abierto: sin depósito ni arqueo
    const deposito = Math.max(0, apertura + efectivo - gasto - FONDO_FIJO_CENTAVOS);
    if (deposito > 0) movimientos.push({ id: `mov_${String(++n).padStart(4, '0')}`, fecha, tipo: 'egreso', concepto: 'Depósito bancario', importe: deposito });
    const esperado = apertura + efectivo - gasto - deposito;
    const contado = esperado + ruidoCaja - (fecha === ANOMALIA_CAJA ? FALTANTE_CAJA_CENTAVOS : 0);
    arqueos.push({ fecha, contado });
    apertura = contado;
  }

  const facturasProveedor = generarFacturasProveedor(ordenes);
  const facturacion = generarFacturacion();
  return {
    proveedores: PROVEEDORES.map((p) => ({ ...p })),
    articulos,
    ventas,
    ordenes,
    movimientos,
    arqueos,
    ...facturacion,
    cobranzas: [],
    facturasProveedor,
    pagosProveedor: [],
    ...generarTesoreria(movimientos, facturasProveedor, facturacion.clientes),
    transferenciasInternas: [],
  };
}

// ---------------------------------------------------------------------------------------------------------- facturación

/**
 * Clientes. Importes en centavos. Casos sembrados a propósito:
 * - Dos homónimos, «Gómez Hnos.» (cuenta corriente) y «Gómez, Laura» (contado): «Gómez» a secas es ambiguo.
 * - «Colegio San Martín» (cli_05) no paga nunca: todas sus facturas quedan vencidas.
 * - «Distribuidora Norte SRL» (cli_07) tiene un límite de crédito bajo y lo supera con lo que debe (el único cliente que lo supera).
 * Cobranzas reutiliza estos mismos clientes y facturas: no tiene entidades propias salvo el cobro (`Cobranza`). Con estos datos,
 * solo cli_05 y cli_07 tienen facturas vencidas de más de 60 días de antigüedad (contada desde la emisión).
 */
const CLIENTES: Cliente[] = [
  { id: 'cli_01', nombre: 'Ferretería del Centro S.A.', condicion_pago: 'cuenta_corriente', limite_credito: 3_000_000, tipo_comprobante: 'A', plazo_dias: 30 },
  { id: 'cli_02', nombre: 'Estudio Contable Ríos', condicion_pago: 'cuenta_corriente', limite_credito: 1_200_000, tipo_comprobante: 'A', plazo_dias: 30 },
  { id: 'cli_03', nombre: 'Gómez Hnos.', condicion_pago: 'cuenta_corriente', limite_credito: 2_500_000, tipo_comprobante: 'A', plazo_dias: 30 },
  { id: 'cli_04', nombre: 'Gómez, Laura', condicion_pago: 'contado', limite_credito: 0, tipo_comprobante: 'B', plazo_dias: 0 },
  { id: 'cli_05', nombre: 'Colegio San Martín', condicion_pago: 'cuenta_corriente', limite_credito: 5_000_000, tipo_comprobante: 'A', plazo_dias: 30 },
  { id: 'cli_06', nombre: 'Kiosco La Esquina', condicion_pago: 'contado', limite_credito: 0, tipo_comprobante: 'B', plazo_dias: 0 },
  { id: 'cli_07', nombre: 'Distribuidora Norte SRL', condicion_pago: 'cuenta_corriente', limite_credito: 1_500_000, tipo_comprobante: 'A', plazo_dias: 30 },
  { id: 'cli_08', nombre: 'Panadería Don Julio', condicion_pago: 'contado', limite_credito: 0, tipo_comprobante: 'B', plazo_dias: 0 },
  { id: 'cli_09', nombre: 'Consultorio Dra. Peralta', condicion_pago: 'cuenta_corriente', limite_credito: 2_000_000, tipo_comprobante: 'A', plazo_dias: 15 },
  { id: 'cli_10', nombre: 'Inmobiliaria Cuyo', condicion_pago: 'cuenta_corriente', limite_credito: 1_800_000, tipo_comprobante: 'A', plazo_dias: 30 },
  { id: 'cli_11', nombre: 'Taller Mecánico Ibarra', condicion_pago: 'cuenta_corriente', limite_credito: 1_500_000, tipo_comprobante: 'A', plazo_dias: 30 },
  { id: 'cli_12', nombre: 'Librería Atenea', condicion_pago: 'contado', limite_credito: 0, tipo_comprobante: 'B', plazo_dias: 0 },
];

const CLIENTE_MOROSO = 'cli_05';
const CLIENTE_EXCEDIDO = 'cli_07';
const PRIMER_NUMERO: Record<'A' | 'B', number> = { A: 1_180, B: 3_460 };
const PRIMER_NUMERO_NC: Record<'A' | 'B', number> = { A: 41, B: 112 };

const numeroComprobante = (n: number): string => `0001-${String(n).padStart(8, '0')}`;

/**
 * Genera clientes, facturas de venta y notas de crédito. Usa su propio generador (semilla distinta) para no alterar
 * ni un número de los datos de ventas y caja. Las facturas son comprobantes aparte: no desglosan las ventas de
 * mostrador y online, que el ERP sintético lleva agregadas por artículo y no por cliente.
 *
 * Reglas del generador: los clientes de contado pagan en el acto; los de cuenta corriente pagan casi todo lo anterior
 * a mediados de febrero (con algún pago parcial) y dejan abierto lo reciente. El moroso no paga nada y el excedido
 * deja abierto todo desde fines de enero. Dos facturas quedan anuladas con una nota de crédito total y una tiene una
 * nota de crédito parcial, para que haya historia antes de que el agente emita las suyas.
 */
function generarFacturacion(): Pick<DatosErp, 'clientes' | 'facturas' | 'notasCredito'> {
  const rng = mulberry32(SEMILLA ^ 0xfac7);
  const bruto: Omit<Factura, 'id' | 'numero' | 'estado'>[] = [];
  for (const fecha of rango(INICIO_DATOS, HOY)) {
    for (const c of CLIENTES) {
      // Se consumen siempre las mismas tiradas por cliente y día, haya o no factura.
      const emite = rng();
      const monto = rng();
      const cobro = rng();
      const parte = rng();
      const cc = c.condicion_pago === 'cuenta_corriente';
      if (emite >= (cc ? 0.1 : 0.06)) continue;
      const importe = cc ? Math.round((80_000 + monto * 520_000) / 5) * 5 : Math.round((2_000 + monto * 60_000) / 5) * 5;
      let cobrado = 0;
      if (!cc) cobrado = importe;
      else if (c.id !== CLIENTE_MOROSO) {
        const abierto = c.id === CLIENTE_EXCEDIDO ? fecha >= '2026-01-25' : fecha >= '2026-02-15';
        if (!abierto) cobrado = cobro < 0.85 ? importe : Math.round((importe * (0.3 + parte * 0.4)) / 5) * 5;
        else if (cobro < 0.2) cobrado = Math.round((importe * (0.3 + parte * 0.4)) / 5) * 5;
      }
      bruto.push({ tipo: c.tipo_comprobante, cliente_id: c.id, fecha, vencimiento: sumarDias(fecha, c.plazo_dias), importe, cobrado, acreditado: 0 });
    }
  }
  const siguiente: Record<'A' | 'B', number> = { A: PRIMER_NUMERO.A, B: PRIMER_NUMERO.B };
  const facturas: Factura[] = bruto.map((f, i) => {
    const factura: Factura = { ...f, id: `fac_${String(i + 1).padStart(4, '0')}`, numero: numeroComprobante(siguiente[f.tipo]++), estado: 'emitida' };
    factura.estado = estadoDeFactura(factura);
    return factura;
  });

  // Notas de crédito previas: dos totales (facturas sin cobros, que quedan anuladas) y una parcial.
  const notasCredito: NotaCredito[] = [];
  const siguienteNc: Record<'A' | 'B', number> = { A: PRIMER_NUMERO_NC.A, B: PRIMER_NUMERO_NC.B };
  const acreditar = (f: Factura | undefined, importe: number, fecha: string, motivo: string): void => {
    if (!f) return;
    f.acreditado += importe;
    f.estado = estadoDeFactura(f);
    notasCredito.push({ id: `nc_${String(notasCredito.length + 1).padStart(4, '0')}`, numero: numeroComprobante(siguienteNc[f.tipo]++), tipo: f.tipo, factura_id: f.id, fecha, importe, motivo });
  };
  const sinCobro = (cliente: string, desde: string): Factura | undefined => facturas.find((f) => f.cliente_id === cliente && f.fecha >= desde && f.cobrado === 0 && f.acreditado === 0);
  const anulada1 = sinCobro('cli_02', '2026-02-01');
  const anulada2 = sinCobro('cli_11', '2026-02-10');
  const parcial = sinCobro('cli_09', '2026-02-20');
  acreditar(anulada1, anulada1?.importe ?? 0, anulada1 ? sumarDias(anulada1.fecha, 2) : HOY, 'Error de facturación: cliente equivocado');
  acreditar(anulada2, anulada2?.importe ?? 0, anulada2 ? sumarDias(anulada2.fecha, 3) : HOY, 'Pedido cancelado antes de la entrega');
  acreditar(parcial, parcial ? Math.round(parcial.importe / 10 / 5) * 5 : 0, parcial ? sumarDias(parcial.fecha, 5) : HOY, 'Bonificación acordada');
  return { clientes: CLIENTES.map((c) => ({ ...c })), facturas, notasCredito };
}

export { sumarDias };


// ---------------------------------------------------------------------------------------------------- cuentas a pagar

/**
 * Facturas de proveedor, escritas a mano (no hay generador: los casos tienen que ser exactos). Importes en centavos.
 * HOY es martes 2026-03-31, así que «esta semana» llega hasta el domingo 2026-04-05. Casos sembrados:
 * - Dos homónimos, «Gómez Insumos SA» (prv_05, tres facturas) y «Gómez, Ricardo» (prv_06, una): «Gómez» a secas es ambiguo.
 * - Vencidas: Aurora (fpr_0002), Tecnoparts (fpr_0005), Papelera Central (fpr_0007), Gómez Insumos (fpr_0011) y Ricardo Gómez (fpr_0014).
 * - Vencen hoy o esta semana: fpr_0008 (hoy), fpr_0012 (01/04), fpr_0003 (02/04, con un pago parcial previo) y fpr_0006 (03/04).
 * - Fuera de la semana: fpr_0010 (08/04), fpr_0013 (11/04) y fpr_0015 (28/04).
 * - Vinculadas a una orden de compra recibida: fpr_0001, fpr_0004, fpr_0007 y fpr_0009, por el total de la orden. Tres ya
 *   están pagadas; la de Papelera Central (fpr_0007) sigue abierta y vencida.
 * - Anomalía: fpr_0015 repite número e importe de fpr_0005 (Tecnoparts, cargada dos veces); la propuesta de pago lo advierte.
 * Pagos recibe estas mismas facturas y proveedores: no hay otra entidad salvo el pago (`PagoProveedor`).
 */
function generarFacturasProveedor(ordenes: OrdenCompra[]): FacturaProveedor[] {
  const totalOrden = (id: string): number => (ordenes.find((o) => o.id === id)?.lineas ?? []).reduce((s, l) => s + l.costo_unitario * l.cantidad, 0);
  type Base = Omit<FacturaProveedor, 'estado'>;
  const bases: Base[] = [
    { id: 'fpr_0001', numero: '0003-00004120', proveedor_id: 'prv_01', orden_id: 'oc_0001', fecha: '2026-01-14', vencimiento: '2026-02-13', importe: totalOrden('oc_0001'), pagado: totalOrden('oc_0001') },
    { id: 'fpr_0002', numero: '0003-00004388', proveedor_id: 'prv_01', fecha: '2026-02-20', vencimiento: '2026-03-22', importe: 96_500, pagado: 0 },
    { id: 'fpr_0003', numero: '0003-00004471', proveedor_id: 'prv_01', fecha: '2026-03-10', vencimiento: '2026-04-02', importe: 142_000, pagado: 40_000 },
    { id: 'fpr_0004', numero: '0011-00076544', proveedor_id: 'prv_02', orden_id: 'oc_0002', fecha: '2026-01-28', vencimiento: '2026-02-27', importe: totalOrden('oc_0002'), pagado: totalOrden('oc_0002') },
    { id: 'fpr_0005', numero: '0011-00077210', proveedor_id: 'prv_02', fecha: '2026-03-02', vencimiento: '2026-03-27', importe: 215_000, pagado: 0 },
    { id: 'fpr_0006', numero: '0011-00077533', proveedor_id: 'prv_02', fecha: '2026-03-20', vencimiento: '2026-04-03', importe: 86_400, pagado: 0 },
    { id: 'fpr_0007', numero: '0002-00001907', proveedor_id: 'prv_03', orden_id: 'oc_0003', fecha: '2026-02-11', vencimiento: '2026-03-13', importe: totalOrden('oc_0003'), pagado: 0 },
    { id: 'fpr_0008', numero: '0002-00002015', proveedor_id: 'prv_03', fecha: '2026-03-16', vencimiento: '2026-03-31', importe: 31_250, pagado: 0 },
    { id: 'fpr_0009', numero: '0005-00000873', proveedor_id: 'prv_04', orden_id: 'oc_0004', fecha: '2026-02-25', vencimiento: '2026-03-27', importe: totalOrden('oc_0004'), pagado: totalOrden('oc_0004') },
    { id: 'fpr_0010', numero: '0005-00000961', proveedor_id: 'prv_04', fecha: '2026-03-24', vencimiento: '2026-04-08', importe: 54_000, pagado: 0 },
    { id: 'fpr_0011', numero: '0007-00000912', proveedor_id: 'prv_05', fecha: '2026-02-26', vencimiento: '2026-03-13', importe: 128_000, pagado: 0 },
    { id: 'fpr_0012', numero: '0007-00001004', proveedor_id: 'prv_05', fecha: '2026-03-17', vencimiento: '2026-04-01', importe: 94_500, pagado: 0 },
    { id: 'fpr_0013', numero: '0007-00001057', proveedor_id: 'prv_05', fecha: '2026-03-27', vencimiento: '2026-04-11', importe: 67_800, pagado: 0 },
    { id: 'fpr_0014', numero: '0001-00000231', proveedor_id: 'prv_06', fecha: '2026-03-18', vencimiento: '2026-03-25', importe: 45_000, pagado: 0 },
    { id: 'fpr_0015', numero: '0011-00077210', proveedor_id: 'prv_02', fecha: '2026-03-29', vencimiento: '2026-04-28', importe: 215_000, pagado: 0 },
  ];
  return bases.map((b) => ({ ...b, estado: estadoDeFacturaProveedor(b) }));
}


// ------------------------------------------------------------------------------------------------------------- tesorería

export const CUENTA_NACION = 'cta_01';
export const CUENTA_GALICIA = 'cta_02';
export const CUENTA_SANTANDER = 'cta_03';

/** Días que tarda como máximo el banco en acreditar un depósito: la ventana en que `conciliar_depositos` busca el crédito. */
export const VENTANA_ACREDITACION_DIAS = 3;
/** Depósito de caja que el banco acreditó por menos (la diferencia de abajo) y depósito que no acreditó. */
export const DEPOSITO_CON_DIFERENCIA = '2026-03-12';
export const DIFERENCIA_DEPOSITO_CENTAVOS = 12_000;
export const DEPOSITO_SIN_ACREDITAR = '2026-03-26';

/**
 * Cuentas bancarias. Importes en centavos de la moneda de cada cuenta. Casos sembrados a propósito:
 * - Las dos primeras son en USD, así que una transferencia interna entre ellas es válida; la tercera es en ARS y una
 *   transferencia entre esa y cualquiera de las otras se rechaza por monedas distintas.
 * - Los depósitos de caja van a la cuenta del Nación.
 */
const CUENTAS: CuentaBancaria[] = [
  { id: CUENTA_NACION, nombre: 'Banco Nación CC 1234', moneda: 'USD', saldo_inicial: 2_000_000 },
  { id: CUENTA_GALICIA, nombre: 'Banco Galicia CA USD 5678', moneda: 'USD', saldo_inicial: 1_500_000 },
  { id: CUENTA_SANTANDER, nombre: 'Banco Santander CC ARS 9012', moneda: 'ARS', saldo_inicial: 900_000_000 },
];

const COMISION_MENSUAL: Record<string, number> = { [CUENTA_NACION]: 1_800, [CUENTA_GALICIA]: 900, [CUENTA_SANTANDER]: 250_000 };
/** Impuesto sobre los débitos del mes (simplificado: un solo porcentaje, en milésimas de punto, sobre los débitos de la cuenta). */
const IMPUESTO_DEBITOS_MILESIMAS = 6;

const finDeMes = (fecha: string): string => {
  const d = new Date(`${fecha.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

/**
 * Genera las cuentas bancarias y su extracto. Usa su propio generador (semilla distinta): no altera ni un número de los
 * datos anteriores. Cada movimiento nace de un dato que ya existe en el ERP:
 * - Un crédito «Depósito en efectivo» por cada egreso «Depósito bancario» de caja, en el Nación, por el mismo importe, 0 a 2 días
 *   después del egreso (nunca después de hoy). Dos excepciones sembradas: el depósito del 12/03 se acreditó por 120.00 menos (una
 *   diferencia) y el del 26/03 no se acreditó (pendiente). Con ellas, `conciliar_depositos` encuentra exactamente un caso de cada uno.
 * - Un débito por cada pago a proveedor que las facturas ya traen hecho (`FacturaProveedor.pagado`), a la fecha de vencimiento
 *   (o a hoy si todavía no venció), desde el Nación.
 * - Algunas acreditaciones de transferencias de clientes en cuenta corriente (nunca del moroso), sobre todo al Nación y algunas al Galicia.
 * - Una comisión de mantenimiento por cuenta y mes, y un impuesto sobre los débitos del mes en las dos cuentas en USD, ambos el último día del mes.
 * Los cobros y pagos que se registren después con el ERP no generan movimientos bancarios: los cobros por transferencia o cheque
 * y las transferencias a proveedores quedan fuera del extracto (los pagos, como `pendiente_debito`).
 */
function generarTesoreria(movimientosCaja: MovimientoCaja[], facturasProveedor: FacturaProveedor[], clientes: Cliente[]): Pick<DatosErp, 'cuentasBancarias' | 'movimientosBancarios'> {
  const rng = mulberry32(SEMILLA ^ 0xba2c);
  const crudos: Omit<MovimientoBancario, 'id'>[] = [];

  for (const m of movimientosCaja) {
    if (m.tipo !== 'egreso' || m.concepto !== 'Depósito bancario') continue;
    const demora = Math.floor(rng() * 3); // 0, 1 o 2 días; se consume siempre para no desordenar el resto
    if (m.fecha === DEPOSITO_SIN_ACREDITAR) continue;
    const acreditado = sumarDias(m.fecha, demora);
    const importe = m.fecha === DEPOSITO_CON_DIFERENCIA ? m.importe - DIFERENCIA_DEPOSITO_CENTAVOS : m.importe;
    crudos.push({ cuenta_id: CUENTA_NACION, fecha: acreditado > HOY ? HOY : acreditado, sentido: 'credito', tipo: 'deposito_caja', concepto: 'Depósito en efectivo', importe });
  }

  const pagadoras = clientes.filter((c) => c.condicion_pago === 'cuenta_corriente' && c.id !== CLIENTE_MOROSO);
  for (const fecha of rango(INICIO_DATOS, HOY)) {
    const llega = rng();
    const quien = rng();
    const monto = rng();
    const cuenta = rng();
    if (llega >= 0.22) continue;
    const cliente = pagadoras[Math.floor(quien * pagadoras.length)] ?? pagadoras[0];
    if (!cliente) continue;
    crudos.push({ cuenta_id: cuenta < 0.7 ? CUENTA_NACION : CUENTA_GALICIA, fecha, sentido: 'credito', tipo: 'acreditacion_cliente', concepto: `Transferencia ${cliente.nombre}`, importe: Math.round((15_000 + monto * 135_000) / 5) * 5 });
  }

  for (const f of facturasProveedor) {
    if (f.pagado <= 0) continue;
    const proveedor = PROVEEDORES.find((p) => p.id === f.proveedor_id);
    crudos.push({ cuenta_id: CUENTA_NACION, fecha: f.vencimiento > HOY ? HOY : f.vencimiento, sentido: 'debito', tipo: 'debito_proveedor', concepto: `Transferencia a ${proveedor?.nombre ?? f.proveedor_id}, factura ${f.numero}`, importe: f.pagado });
  }

  for (const cuenta of CUENTAS) {
    for (const mes of ['2026-01', '2026-02', '2026-03']) {
      const fecha = finDeMes(`${mes}-01`);
      if (fecha > HOY) continue;
      crudos.push({ cuenta_id: cuenta.id, fecha, sentido: 'debito', tipo: 'comision', concepto: 'Comisión de mantenimiento de cuenta', importe: COMISION_MENSUAL[cuenta.id] ?? 0 });
      if (cuenta.moneda !== 'USD') continue;
      const debitos = crudos.filter((x) => x.cuenta_id === cuenta.id && x.sentido === 'debito' && x.tipo !== 'impuesto' && x.fecha.startsWith(mes)).reduce((s, x) => s + x.importe, 0);
      crudos.push({ cuenta_id: cuenta.id, fecha, sentido: 'debito', tipo: 'impuesto', concepto: 'Impuesto sobre débitos bancarios', importe: Math.round((debitos * IMPUESTO_DEBITOS_MILESIMAS) / 1000) });
    }
  }

  const ordenados = crudos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.cuenta_id.localeCompare(b.cuenta_id) || a.sentido.localeCompare(b.sentido) || a.concepto.localeCompare(b.concepto));
  return {
    cuentasBancarias: CUENTAS.map((c) => ({ ...c })),
    movimientosBancarios: ordenados.map((m, i) => ({ id: `mba_${String(i + 1).padStart(4, '0')}`, ...m })),
  };
}
