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

export interface DatosErp {
  proveedores: Proveedor[];
  articulos: Articulo[];
  ventas: Venta[];
  ordenes: OrdenCompra[];
  movimientos: MovimientoCaja[];
  arqueos: Arqueo[];
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

  return { proveedores: PROVEEDORES.map((p) => ({ ...p })), articulos, ventas, ordenes, movimientos, arqueos };
}

export { sumarDias };
