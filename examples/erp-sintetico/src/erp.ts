import {
  MAX_MOTIVO,
  RegistroIdempotenciaMemoria,
  centavosDeDinero,
  consultarIdempotencia,
  dineroDeCentavos,
  emitirToken,
  esObjeto,
  hashPayload,
  hashPin,
  multiplicar,
  pideMotivo,
  pideSupervisor,
  registrarIdempotencia,
  sumarCentavos,
  tokenCoincide,
  verificarPin,
  type Anomalia,
  type ConfirmarSalida,
  type ConsumirEventosSalida,
  type ContextoSesion,
  type DefMetrica,
  type Dinero,
  type EventoErp,
  type KpiMetrica,
  type Obj,
  type Propuesta,
  type RegistroIdempotencia,
  type SalidaDetalle,
  type SalidaMetricas,
  type SalidaSerie,
  type SalidaTabla,
  type StepUp,
  type ValorMetrica,
} from '@agentic-erp/mcp-contract';
import { ANOMALIA_CAJA, HOY, LISTA_MINORISTA, redondear5, INICIO_DATOS, MONEDA, VENTANA_ACREDITACION_DIAS, estadoDeFactura, estadoDeFacturaProveedor, generarDatos, saldoDeCuenta, saldoDeFactura, saldoDeFacturaProveedor, type Articulo, type Cliente, type Cobranza, type CambioPrecio, type CuentaBancaria, type DatosErp, type ListaPrecios, type Factura, type FacturaProveedor, type MedioCobro, type MedioPago, type MovimientoBancario, type MovimientoCaja, type TipoMovimientoBancario, type TransferenciaInterna, type NotaCredito, type OrdenCompra, type PagoProveedor, type Proveedor } from './datos.js';
import { NOMBRES_DIA, diaDeSemana, diasEntre, esFecha, rango, sumarDias } from './fechas.js';
import { ROLES_AUTORIZADORES, ROLES_POR_ESCRITURA } from './permisos.js';

/** Error de negocio con código del contrato. El servidor MCP lo convierte en `isError`. */
export class ErrorErp extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
    readonly accion_sugerida?: string,
  ) {
    super(mensaje);
  }
}

export interface OpcionesErp {
  reloj?: () => Date;
  datos?: DatosErp;
  /** Usuarios que pueden autorizar un step-up: usuario -> { pin, rol }. Sin ninguno, todo step-up falla. */
  autorizadores?: Record<string, { pin: string; rol: string }>;
  /** Minutos de vigencia de una propuesta. */
  vigenciaMin?: number;
  /** Tabla de idempotencia de `confirmar_*`. Por defecto, la de memoria del kit de `mcp-contract`. */
  idempotencia?: RegistroIdempotencia;
  /** Umbrales de caja en centavos. Por defecto 500.00 (egreso con supervisor) y 2000.00 (supervisor y motivo). */
  umbralesCaja?: { supervisor?: number; supervisorYMotivo?: number };
  /** Importe de nota de crédito, en centavos, desde el cual se pide la confirmación de un supervisor. Por defecto 1000.00. */
  umbralNotaCredito?: number;
  /** Importe de cobranza, en centavos, desde el cual se pide la confirmación de un supervisor. Por defecto 5000.00. */
  umbralCobranza?: number;
  /** Importe de pago a proveedor, en centavos, desde el cual se pide la confirmación de un supervisor. Por defecto 1000.00. */
  umbralPagoProveedor?: number;
  /** Importe de pago a proveedor, en centavos, desde el cual se pide además el motivo. Por defecto 5000.00. */
  umbralMotivoPagoProveedor?: number;
  /** Importe de transferencia interna entre cuentas propias, en centavos, desde el cual se pide la confirmación de un supervisor. Por defecto 5000.00. */
  umbralTransferenciaInterna?: number;
  /**
   * Precios y listas. `variacionPct`: un cambio de precio de más de este porcentaje (hacia arriba o hacia abajo) pide un supervisor (por defecto 15).
   * `masivo`: un cambio de más de esta cantidad de artículos pide un supervisor (por defecto 5). `margenMinimoPct`: margen mínimo por defecto
   * de `articulos_margen_bajo` y de las advertencias (por defecto 15).
   */
  umbralesPrecios?: { variacionPct?: number; masivo?: number; margenMinimoPct?: number };
}

type Efecto =
  | { tipo: 'ajuste_stock'; articulo_id: string; existencia_nueva: number }
  | { tipo: 'orden_compra'; proveedor_id: string; lineas: { articulo_id: string; cantidad: number; costo_unitario: number }[] }
  | { tipo: 'movimiento_caja'; mov: Omit<MovimientoCaja, 'id' | 'fecha'> }
  | { tipo: 'nota_credito'; factura_id: string; importe: number; motivo: string }
  | { tipo: 'cobranza'; cliente_id: string; medio: MedioCobro; importe: number }
  | { tipo: 'pago_proveedor'; proveedor_id: string; medio: MedioPago; importe: number; factura_ids: string[] }
  | { tipo: 'transferencia_interna'; origen_id: string; destino_id: string; importe: number }
  | { tipo: 'cambio_precio'; lista_id: string; cambios: { articulo_id: string; precio_anterior: number; precio_nuevo: number }[]; motivo?: string };

interface PropuestaGuardada {
  id: string;
  token: string;
  expira: number;
  efecto: Efecto;
  total: Dinero | undefined;
  stepUp: StepUp;
  creador: string;
  estado: 'abierta' | 'confirmada';
  /** Hash del efecto al preparar: al confirmar se recalcula para detectar que la propuesta guardada no fue alterada. */
  hashEfecto: string;
}

interface CierreCaja {
  fecha: string;
  apertura: number;
  esperado: number;
  contado: number;
}

export interface EntradaAuditoria {
  usuario: string;
  rol: string;
  origen: string;
  tool: string;
  autorizo?: string;
  /** Motivo escrito por la persona al confirmar (step-up con motivo). */
  motivo?: string;
}

const UMBRAL_STEP_UP_CAJA = 50_000; // 500.00: egresos desde acá piden un supervisor
const UMBRAL_MOTIVO_CAJA = 200_000; // 2000.00: egresos desde acá piden supervisor y motivo; ingresos desde 500.00 piden motivo
const UMBRAL_STEP_UP_COMPRA = 500_000; // 5000.00
const UMBRAL_DIFERENCIA_CAJA = 1_000; // 10.00
const UMBRAL_STEP_UP_NOTA_CREDITO = 100_000; // 1000.00: notas de crédito desde acá piden un supervisor
const UMBRAL_STEP_UP_COBRANZA = 500_000; // 5000.00: cobranzas desde acá piden un supervisor
const UMBRAL_STEP_UP_PAGO_PROVEEDOR = 100_000; // 1000.00: pagos desde acá piden un supervisor
const UMBRAL_MOTIVO_PAGO_PROVEEDOR = 500_000; // 5000.00: pagos desde acá piden supervisor y motivo
const UMBRAL_STEP_UP_TRANSFERENCIA = 500_000; // 5000.00: transferencias internas desde acá piden un supervisor
const UMBRAL_VARIACION_PRECIO_PCT = 15; // un cambio de precio de más de 15 % (hacia arriba o abajo) pide un supervisor
const UMBRAL_CAMBIO_MASIVO = 5; // un cambio de más de 5 artículos pide un supervisor
const MARGEN_MINIMO_PCT = 15; // margen por debajo del cual un artículo se considera de margen bajo
const MODOS_CAMBIO_PRECIO = ['precio', 'porcentaje', 'margen'] as const;
const CONCEPTO_DEPOSITO_CAJA = 'Depósito bancario';
const TIPOS_MOVIMIENTO_BANCARIO: readonly TipoMovimientoBancario[] = ['deposito_caja', 'acreditacion_cliente', 'debito_proveedor', 'comision', 'impuesto', 'transferencia_interna'];
const MEDIOS_PAGO: readonly MedioPago[] = ['efectivo', 'transferencia'];
const ETIQUETA_MEDIO_PAGO: Record<MedioPago, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia' };
const MEDIOS_COBRO: readonly MedioCobro[] = ['efectivo', 'transferencia', 'cheque'];
const ETIQUETA_MEDIO: Record<MedioCobro, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque' };

export const METRICAS: DefMetrica[] = [
  { id: 'ventas_total', etiqueta: 'Ventas', descripcion: 'Ingresos por ventas en el período, todos los canales.', tipo: 'moneda', dimensiones: ['dia', 'articulo', 'categoria', 'canal'], sentido_favorable: 'mayor_es_mejor' },
  { id: 'unidades_vendidas', etiqueta: 'Unidades vendidas', descripcion: 'Unidades vendidas en el período.', tipo: 'cantidad', dimensiones: ['dia', 'articulo', 'categoria', 'canal'], sentido_favorable: 'mayor_es_mejor' },
  { id: 'margen_bruto_pct', etiqueta: 'Margen bruto', descripcion: 'Ventas menos costo de lo vendido, sobre ventas.', tipo: 'porcentaje', dimensiones: ['dia', 'categoria'], sentido_favorable: 'mayor_es_mejor' },
  { id: 'compras_total', etiqueta: 'Compras', descripcion: 'Total de órdenes de compra emitidas en el período.', tipo: 'moneda', dimensiones: ['proveedor'], sentido_favorable: 'menor_es_mejor' },
  { id: 'faltante_caja', etiqueta: 'Faltante de caja', descripcion: 'Suma de lo que faltó en los arqueos del período (esperado menos contado, solo faltantes).', tipo: 'moneda', dimensiones: ['dia'], sentido_favorable: 'menor_es_mejor' },
];

/** Hash de relleno: verificar contra algo cuando el usuario no existe evita que el tiempo de respuesta delate qué usuarios hay. */
const PIN_HASH_RELLENO = hashPin('relleno');

const normalizar = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmt = (centavos: number): string => {
  const d = dineroDeCentavos(centavos, MONEDA);
  return `${d.monto} ${d.moneda}`;
};
const dinero = (c: number): Dinero => dineroDeCentavos(c, MONEDA);
const montoUmbral = (centavos: number): string => dinero(centavos).monto;
/** Importes de una cuenta bancaria, en la moneda de la cuenta (las cuentas en ARS no son USD). */
const dineroEn = (centavos: number, moneda: string): Dinero => dineroDeCentavos(centavos, moneda);
const fmtEn = (centavos: number, moneda: string): string => {
  const d = dineroEn(centavos, moneda);
  return `${d.monto} ${d.moneda}`;
};

/** Una alerta del día: lo que detectan las otras áreas, con el porqué y qué área la resuelve. */
interface AlertaGestion {
  id: string;
  prioridad: 'alta' | 'media' | 'baja';
  titulo: string;
  por_que: string;
  area: string;
  referencia: string;
}

/** Cómo se llama cada área en la tabla de alertas (la persona sabe a quién pedirle qué). */
const NOMBRE_AREA: Record<string, string> = { ventas: 'Ventas', caja: 'Caja', tesoreria: 'Tesorería y bancos', pagos: 'Pagos a proveedores', cobranzas: 'Clientes y cobranzas', compras: 'Compras', precios: 'Precios y listas' };
const ORDEN_PRIORIDAD = { alta: 0, media: 1, baja: 2 } as const;
/** Ventana de las anomalías que entran en las alertas: los últimos N días contando hoy. */
const DIAS_ANOMALIAS_ALERTA = 14;
/** Una factura de proveedor entra en las alertas cuando vence dentro de estos días. */
const DIAS_VENCIMIENTO_ALERTA = 3;
/** Antigüedad (días desde la emisión) desde la que la deuda vencida de un cliente es alerta. */
const DIAS_DEUDA_CLIENTE_ALERTA = 60;
/** Cuántas alertas de prioridad alta o media lista el cierre del día como pendientes. */
const MAX_PENDIENTES_CIERRE = 15;

/** Resultado de cruzar un depósito de caja con el extracto: ver `conciliarDepositos`. */
interface DepositoConciliado {
  deposito: MovimientoCaja;
  credito: MovimientoBancario | undefined;
  estado: 'conciliado' | 'con_diferencia' | 'pendiente';
}

/** Un indicador de moneda (USD) o cantidad con su comparación contra el período anterior, si hay con qué comparar. Lo usan facturación y la gestión. */
function kpiConComparacion(id: string, etiqueta: string, tipo: 'moneda' | 'cantidad', valor: number, anterior: number | undefined, sentido: KpiMetrica['sentido_favorable'], periodoAnterior: string): KpiMetrica {
  const v = (x: number): ValorMetrica => (tipo === 'moneda' ? { tipo: 'moneda', valor: dinero(x).monto, moneda: MONEDA } : { tipo: 'cantidad', valor: String(x) });
  const k: KpiMetrica = { id, etiqueta, valor: v(valor), sentido_favorable: sentido };
  if (anterior !== undefined && anterior !== 0) {
    const pct = ((valor - anterior) / Math.abs(anterior)) * 100;
    k.comparacion = { variacion_pct: pct.toFixed(1), periodo_anterior: periodoAnterior, valor_anterior: v(anterior) };
    k.tendencia = pct > 2 ? 'sube' : pct < -2 ? 'baja' : 'estable';
  }
  return k;
}

/** Porcentaje tal como lo escribe una persona: «8», «-12.5», «8,5 %». Devuelve centésimas de punto (800 es 8 %). */
export function parsearPorcentaje(v: unknown, campo = 'porcentaje'): number {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^([+-]?)(\d{1,4})(?:[.,](\d{1,2}))?\s*%?$/.exec(s);
  if (!m) throw new ErrorErp('PARAMETRO_INVALIDO', `${campo} no es válido. Usá un número con hasta dos decimales, por ejemplo 8 o 12,5.`, 'Pedile a la persona el porcentaje de nuevo.');
  const bp = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -bp : bp;
}

/** Margen sobre el precio de venta, en centésimas de punto: (precio - costo) / precio. */
const margenBp = (precio: number, costo: number): number => Math.round(((precio - costo) * 10_000) / precio);
const textoPct = (bp: number): string => `${(bp / 100).toFixed(1)}`;
const textoVariacion = (bp: number): string => `${bp > 0 ? '+' : ''}${(bp / 100).toFixed(1)}`;

/** Importe tal como lo escribe una persona: «150», «150.5», «150,50». Devuelve centavos. */
export function parsearImporte(v: unknown): number {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) throw new ErrorErp('PARAMETRO_INVALIDO', 'El importe no es válido. Usá un número positivo con hasta dos decimales.', 'Pedile a la persona el importe de nuevo.');
  const c = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (c <= 0) throw new ErrorErp('PARAMETRO_INVALIDO', 'El importe debe ser mayor que cero.');
  return c;
}

function entero(v: unknown, campo: string, min: number, max: number): number {
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new ErrorErp('PARAMETRO_INVALIDO', `${campo} debe ser un entero entre ${min} y ${max}.`);
  return n;
}

function fechaValida(v: unknown, campo: string): string {
  if (!esFecha(v)) throw new ErrorErp('PARAMETRO_INVALIDO', `${campo} debe ser una fecha AAAA-MM-DD.`);
  return v;
}

/**
 * La lógica del ERP sintético, sin MCP: consultas, la capa semántica de métricas, detección de anomalías y el ciclo
 * preparar/confirmar con token, expiración, step-up e idempotencia. `servidor.ts` la expone por MCP.
 */
export class ErpSintetico {
  readonly datos: DatosErp;
  readonly auditoria: EntradaAuditoria[] = [];
  private readonly eventos: EventoErp[] = [];
  private readonly propuestas = new Map<string, PropuestaGuardada>();
  private readonly cierres: CierreCaja[];
  private contadorPropuestas = 0;
  private readonly reloj: () => Date;
  /** Las credenciales se guardan con scrypt (`hashPin`), nunca en claro. */
  private readonly autorizadores: Record<string, { pinHash: string; rol: string }>;
  private readonly vigenciaMs: number;
  private readonly idempotencia: RegistroIdempotencia;
  private readonly umbralSupervisorCaja: number;
  private readonly umbralMotivoCaja: number;
  private readonly umbralNotaCredito: number;
  private readonly umbralCobranza: number;
  private readonly umbralPagoProveedor: number;
  private readonly umbralMotivoPagoProveedor: number;
  private readonly umbralTransferenciaInterna: number;
  private readonly umbralVariacionPrecioBp: number;
  private readonly umbralMasivoPrecios: number;
  private readonly margenMinimoBp: number;

  constructor(o: OpcionesErp = {}) {
    this.datos = o.datos ?? generarDatos();
    this.reloj = o.reloj ?? (() => new Date());
    this.autorizadores = Object.fromEntries(Object.entries(o.autorizadores ?? {}).map(([usuario, a]) => [usuario, { pinHash: hashPin(a.pin), rol: a.rol }]));
    this.vigenciaMs = (o.vigenciaMin ?? 10) * 60_000;
    this.idempotencia = o.idempotencia ?? new RegistroIdempotenciaMemoria();
    this.umbralSupervisorCaja = o.umbralesCaja?.supervisor ?? UMBRAL_STEP_UP_CAJA;
    this.umbralMotivoCaja = o.umbralesCaja?.supervisorYMotivo ?? UMBRAL_MOTIVO_CAJA;
    this.umbralNotaCredito = o.umbralNotaCredito ?? UMBRAL_STEP_UP_NOTA_CREDITO;
    this.umbralCobranza = o.umbralCobranza ?? UMBRAL_STEP_UP_COBRANZA;
    this.umbralPagoProveedor = o.umbralPagoProveedor ?? UMBRAL_STEP_UP_PAGO_PROVEEDOR;
    this.umbralMotivoPagoProveedor = o.umbralMotivoPagoProveedor ?? UMBRAL_MOTIVO_PAGO_PROVEEDOR;
    this.umbralTransferenciaInterna = o.umbralTransferenciaInterna ?? UMBRAL_STEP_UP_TRANSFERENCIA;
    this.umbralVariacionPrecioBp = (o.umbralesPrecios?.variacionPct ?? UMBRAL_VARIACION_PRECIO_PCT) * 100;
    this.umbralMasivoPrecios = o.umbralesPrecios?.masivo ?? UMBRAL_CAMBIO_MASIVO;
    this.margenMinimoBp = (o.umbralesPrecios?.margenMinimoPct ?? MARGEN_MINIMO_PCT) * 100;
    this.cierres = this.calcularCierres();
    this.sembrarEventos();
  }

  /** Texto de la advertencia de step-up de caja, con los umbrales efectivos de esta instancia. */
  private advertenciaStepUpCaja(stepUp: Exclude<StepUp, 'none'>): string {
    switch (stepUp) {
      case 'motivo':
        return `Los ingresos de ${montoUmbral(UMBRAL_STEP_UP_CAJA)} o más necesitan que indiques el motivo.`;
      case 'supervisor':
        return `Los egresos de ${montoUmbral(this.umbralSupervisorCaja)} o más necesitan la autorización de un supervisor.`;
      case 'supervisor_y_motivo':
        return `Los egresos de ${montoUmbral(this.umbralMotivoCaja)} o más necesitan la autorización de un supervisor y el motivo.`;
    }
  }

  // ------------------------------------------------------------------ caja (base)

  private calcularCierres(): CierreCaja[] {
    const out: CierreCaja[] = [];
    let apertura = 50_000;
    for (const a of this.datos.arqueos) {
      const neto = this.datos.movimientos.filter((m) => m.fecha === a.fecha).reduce((s, m) => s + (m.tipo === 'ingreso' ? m.importe : -m.importe), 0);
      const esperado = apertura + neto;
      out.push({ fecha: a.fecha, apertura, esperado, contado: a.contado });
      apertura = a.contado;
    }
    return out;
  }

  private sembrarEventos(): void {
    const cierre = this.cierres.find((c) => c.fecha === ANOMALIA_CAJA);
    if (cierre) this.emitir('arqueo_con_diferencia', { fecha: cierre.fecha, area: 'caja' }, `${cierre.fecha}T21:00:00.000Z`);
    for (const a of this.datos.articulos.filter((x) => x.existencia < x.minimo)) {
      this.emitir('stock_bajo_minimo', { articulo_id: a.id, existencia: a.existencia, minimo: a.minimo }, `${HOY}T07:00:00.000Z`);
    }
  }

  private emitir(tipo: string, payload: Obj, cuando?: string): void {
    this.eventos.push({ secuencia: this.eventos.length + 1, tipo, ocurrido_en: cuando ?? this.reloj().toISOString(), payload });
  }

  private aud(ctx: ContextoSesion, tool: string, autorizo?: string, motivo?: string): void {
    this.auditoria.push({ usuario: ctx.usuario, rol: ctx.rol, origen: ctx.origen ?? 'sin_origen', tool, ...(autorizo ? { autorizo } : {}), ...(motivo ? { motivo } : {}) });
  }

  // ------------------------------------------------------------------ contrato: métricas, series, anomalías, eventos

  listarMetricas(): { metricas: DefMetrica[] } {
    return { metricas: METRICAS };
  }

  private ventasEntre(desde: string, hasta: string) {
    return this.datos.ventas.filter((v) => v.fecha >= desde && v.fecha <= hasta);
  }

  /** Calcula una métrica de la capa semántica. Devuelve el número crudo (centavos, unidades o décimas de punto). */
  private metrica(id: string, desde: string, hasta: string): { tipo: ValorMetrica['tipo']; valor: number } {
    switch (id) {
      case 'ventas_total':
        return { tipo: 'moneda', valor: sumarCentavos(this.ventasEntre(desde, hasta).map((v) => v.ingresos)) };
      case 'unidades_vendidas':
        return { tipo: 'cantidad', valor: this.ventasEntre(desde, hasta).reduce((s, v) => s + v.unidades, 0) };
      case 'margen_bruto_pct': {
        const v = this.ventasEntre(desde, hasta);
        const ing = sumarCentavos(v.map((x) => x.ingresos));
        const cos = sumarCentavos(v.map((x) => x.costo));
        return { tipo: 'porcentaje', valor: ing === 0 ? 0 : Math.round(((ing - cos) / ing) * 1000) / 10 };
      }
      case 'compras_total':
        return { tipo: 'moneda', valor: sumarCentavos(this.datos.ordenes.filter((o) => o.fecha >= desde && o.fecha <= hasta).map((o) => totalOrden(o))) };
      case 'faltante_caja':
        return { tipo: 'moneda', valor: sumarCentavos(this.cierres.filter((c) => c.fecha >= desde && c.fecha <= hasta).map((c) => Math.max(0, c.esperado - c.contado))) };
      default:
        throw new ErrorErp('PARAMETRO_INVALIDO', `La métrica ${id} no existe.`, 'Listá las métricas disponibles con listar_metricas.');
    }
  }

  private valor(m: { tipo: ValorMetrica['tipo']; valor: number }): ValorMetrica {
    if (m.tipo === 'moneda') return { tipo: 'moneda', valor: dinero(m.valor).monto, moneda: MONEDA };
    if (m.tipo === 'porcentaje') return { tipo: 'porcentaje', valor: m.valor.toFixed(1) };
    return { tipo: m.tipo, valor: String(m.valor) };
  }

  consultarMetrica(metricas: unknown, desdeIn: unknown, hastaIn: unknown, comparar: unknown): SalidaMetricas {
    const desde = fechaValida(desdeIn, 'desde');
    const hasta = fechaValida(hastaIn, 'hasta');
    if (desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    if (!Array.isArray(metricas) || metricas.length === 0) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá al menos una métrica.');
    const n = diasEntre(desde, hasta);
    const antDesde = sumarDias(desde, -n);
    const antHasta = sumarDias(desde, -1);
    const kpis: KpiMetrica[] = metricas.map((id) => {
      const def = METRICAS.find((m) => m.id === id);
      if (!def) throw new ErrorErp('PARAMETRO_INVALIDO', `La métrica ${String(id)} no existe.`, 'Listá las métricas disponibles con listar_metricas.');
      const actual = this.metrica(def.id, desde, hasta);
      const kpi: KpiMetrica = { id: def.id, etiqueta: def.etiqueta, valor: this.valor(actual), sentido_favorable: def.sentido_favorable };
      if (comparar === true && antDesde >= INICIO_DATOS) {
        const previo = this.metrica(def.id, antDesde, antHasta);
        if (previo.valor !== 0) {
          const pct = ((actual.valor - previo.valor) / Math.abs(previo.valor)) * 100;
          kpi.comparacion = { variacion_pct: pct.toFixed(1), periodo_anterior: `${antDesde} a ${antHasta}`, valor_anterior: this.valor(previo) };
          kpi.tendencia = pct > 2 ? 'sube' : pct < -2 ? 'baja' : 'estable';
        }
      }
      return kpi;
    });
    return { periodo: { desde, hasta, etiqueta: `${desde} a ${hasta}` }, kpis, fuente: { origen: 'ERP sintético (datos de ejemplo)', actualizado_en: `${HOY}T08:00:00.000Z` } };
  }

  serieMetrica(metricaIn: unknown, desdeIn: unknown, hastaIn: unknown, granularidad: unknown): SalidaSerie {
    const def = METRICAS.find((m) => m.id === metricaIn);
    if (!def) throw new ErrorErp('PARAMETRO_INVALIDO', `La métrica ${String(metricaIn)} no existe.`, 'Listá las métricas disponibles con listar_metricas.');
    const desde = fechaValida(desdeIn, 'desde');
    const hasta = fechaValida(hastaIn, 'hasta');
    if (desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    const porSemana = granularidad === 'semana';
    const dias = rango(desde, hasta);
    if (!porSemana && dias.length > 120) throw new ErrorErp('PARAMETRO_INVALIDO', 'Para más de 120 días usá granularidad semana.');
    const baldes: { etiqueta: string; desde: string; hasta: string }[] = [];
    if (porSemana) {
      for (let f = desde; f <= hasta; ) {
        const hastaSemana = sumarDias(f, (7 - diaDeSemana(f)) % 7); // hasta el domingo
        const fin = hastaSemana > hasta ? hasta : hastaSemana;
        baldes.push({ etiqueta: f, desde: f, hasta: fin });
        f = sumarDias(fin, 1);
      }
    } else {
      for (const f of dias) baldes.push({ etiqueta: f, desde: f, hasta: f });
    }
    const valores = baldes.map((b) => this.valor(this.metrica(def.id, b.desde, b.hasta)).valor);
    return { titulo: `${def.etiqueta} por ${porSemana ? 'semana' : 'día'}`, unidad: def.tipo === 'moneda' ? MONEDA : def.tipo === 'porcentaje' ? '%' : 'unidades', tipo: porSemana ? 'barras' : 'linea', x: baldes.map((b) => b.etiqueta), series: [{ id: def.id, etiqueta: def.etiqueta, valores }] };
  }

  detectarAnomalias(desdeIn: unknown, hastaIn: unknown): { anomalias: Anomalia[] } & SalidaTabla {
    const desde = fechaValida(desdeIn, 'desde');
    const hasta = fechaValida(hastaIn, 'hasta');
    const anomalias: Anomalia[] = [];
    // Ventas: el día contra la mediana de los mismos días de la semana de las 4 semanas anteriores.
    const totalDia = (f: string): number => sumarCentavos(this.datos.ventas.filter((v) => v.fecha === f).map((v) => v.ingresos));
    for (const f of rango(desde < INICIO_DATOS ? INICIO_DATOS : desde, hasta > HOY ? HOY : hasta)) {
      const previos = [1, 2, 3, 4].map((s) => sumarDias(f, -7 * s));
      if (previos.some((p) => p < INICIO_DATOS)) continue;
      const base = mediana(previos.map(totalDia));
      const obs = totalDia(f);
      const ratio = base === 0 ? 1 : obs / base;
      if (ratio < 0.6 || ratio > 1.6) {
        anomalias.push({
          id: `anom_ventas_${f}`,
          titulo: ratio < 0.6 ? 'Caída de ventas' : 'Pico de ventas',
          severidad: ratio < 0.4 ? 'alta' : 'media',
          por_que: 'El total vendido del día se compara con la mediana de los mismos días de la semana de las 4 semanas anteriores; se marca por debajo del 60 % o por encima del 160 %.',
          observado: fmt(obs),
          esperado: fmt(base),
          fecha: f,
        });
      }
    }
    // Caja: arqueos con diferencia de 10.00 o más.
    for (const c of this.cierres.filter((x) => x.fecha >= desde && x.fecha <= hasta)) {
      const dif = c.contado - c.esperado;
      if (Math.abs(dif) >= UMBRAL_DIFERENCIA_CAJA) {
        anomalias.push({
          id: `anom_caja_${c.fecha}`,
          titulo: dif < 0 ? 'Faltante en el arqueo de caja' : 'Sobrante en el arqueo de caja',
          severidad: Math.abs(dif) >= 10_000 ? 'alta' : 'media',
          por_que: 'Se marca todo arqueo cuya diferencia entre lo contado y lo esperado es de 10.00 o más.',
          observado: fmt(c.contado),
          esperado: fmt(c.esperado),
          fecha: c.fecha,
        });
      }
    }
    anomalias.sort((a, b) => (a.fecha ?? '').localeCompare(b.fecha ?? ''));
    return {
      anomalias,
      titulo: 'Anomalías detectadas',
      columnas: [
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'titulo', etiqueta: 'Qué pasó', tipo: 'texto' },
        { id: 'observado', etiqueta: 'Observado', tipo: 'texto' },
        { id: 'esperado', etiqueta: 'Esperado', tipo: 'texto' },
        { id: 'severidad', etiqueta: 'Severidad', tipo: 'estado' },
      ],
      filas: anomalias.map((a) => ({ anomalia_id: a.id, fecha: a.fecha, titulo: a.titulo, observado: a.observado, esperado: a.esperado, severidad: a.severidad })),
      total_filas: anomalias.length,
    };
  }

  consumirEventos(desde: unknown, tipos: unknown, limite: unknown): ConsumirEventosSalida {
    const ultima = this.eventos.length;
    // Sin cursor no hay eventos: se informa la posición actual y el consumidor arranca desde ahí.
    if (desde === undefined) return { eventos: [], siguiente: ultima };
    const cursor = entero(desde, 'desde_secuencia', 0, Number.MAX_SAFE_INTEGER);
    const max = limite === undefined ? 100 : entero(limite, 'limite', 1, 500);
    const filtro = Array.isArray(tipos) && tipos.length ? new Set(tipos.map(String)) : undefined;
    const lote = this.eventos.filter((e) => e.secuencia > cursor && (!filtro || filtro.has(e.tipo))).slice(0, max);
    return { eventos: lote, siguiente: lote.length ? (lote[lote.length - 1] as EventoErp).secuencia : cursor };
  }

  // ------------------------------------------------------------------ ventas

  resumenVentas(desdeIn: unknown, hastaIn: unknown, agruparPor: unknown): SalidaTabla {
    const desde = fechaValida(desdeIn, 'desde');
    const hasta = fechaValida(hastaIn, 'hasta');
    const grupo = (['dia', 'articulo', 'categoria', 'canal'] as const).find((g) => g === agruparPor) ?? 'dia';
    const nombreArt = new Map(this.datos.articulos.map((a) => [a.id, a]));
    const acc = new Map<string, { unidades: number; ingresos: number; costo: number }>();
    for (const v of this.ventasEntre(desde, hasta)) {
      const art = nombreArt.get(v.articulo_id);
      const clave = grupo === 'dia' ? v.fecha : grupo === 'articulo' ? (art?.nombre ?? v.articulo_id) : grupo === 'categoria' ? (art?.categoria ?? 'Sin categoría') : v.canal;
      const a = acc.get(clave) ?? { unidades: 0, ingresos: 0, costo: 0 };
      a.unidades += v.unidades;
      a.ingresos += v.ingresos;
      a.costo += v.costo;
      acc.set(clave, a);
    }
    const filas = [...acc].map(([clave, a]) => ({ grupo: clave, unidades: a.unidades, ingresos: dinero(a.ingresos), margen: dinero(a.ingresos - a.costo) }));
    if (grupo === 'dia') filas.sort((a, b) => a.grupo.localeCompare(b.grupo));
    else filas.sort((a, b) => centavosDeDinero(b.ingresos) - centavosDeDinero(a.ingresos));
    return {
      titulo: `Ventas por ${grupo === 'dia' ? 'día' : grupo === 'articulo' ? 'artículo' : grupo === 'categoria' ? 'categoría' : 'canal'}, ${desde} a ${hasta}`,
      columnas: [
        { id: 'grupo', etiqueta: grupo === 'dia' ? 'Fecha' : grupo === 'articulo' ? 'Artículo' : grupo === 'categoria' ? 'Categoría' : 'Canal', tipo: grupo === 'dia' ? 'fecha' : 'texto' },
        { id: 'unidades', etiqueta: 'Unidades', tipo: 'numero' },
        { id: 'ingresos', etiqueta: 'Ingresos', tipo: 'dinero' },
        { id: 'margen', etiqueta: 'Margen', tipo: 'dinero' },
      ],
      filas,
      total_filas: filas.length,
    };
  }

  rankingProductos(desdeIn: unknown, hastaIn: unknown, orden: unknown, limite: unknown): SalidaTabla {
    const desde = fechaValida(desdeIn, 'desde');
    const hasta = fechaValida(hastaIn, 'hasta');
    const max = limite === undefined ? 5 : entero(limite, 'limite', 1, 50);
    const por = (['ingresos', 'unidades', 'margen'] as const).find((o) => o === orden) ?? 'ingresos';
    const acc = new Map<string, { unidades: number; ingresos: number; costo: number }>();
    for (const v of this.ventasEntre(desde, hasta)) {
      const a = acc.get(v.articulo_id) ?? { unidades: 0, ingresos: 0, costo: 0 };
      a.unidades += v.unidades;
      a.ingresos += v.ingresos;
      a.costo += v.costo;
      acc.set(v.articulo_id, a);
    }
    const clave = (a: { unidades: number; ingresos: number; costo: number }): number => (por === 'unidades' ? a.unidades : por === 'margen' ? a.ingresos - a.costo : a.ingresos);
    const filas = [...acc]
      .sort((x, y) => clave(y[1]) - clave(x[1]) || x[0].localeCompare(y[0]))
      .slice(0, max)
      .map(([id, a], i) => ({
        posicion: i + 1,
        articulo_id: id,
        articulo: this.datos.articulos.find((x) => x.id === id)?.nombre ?? id,
        unidades: a.unidades,
        ingresos: dinero(a.ingresos),
        margen_pct: a.ingresos === 0 ? '0.0' : (((a.ingresos - a.costo) / a.ingresos) * 100).toFixed(1),
      }));
    return {
      titulo: `Top ${filas.length} artículos por ${por}, ${desde} a ${hasta}`,
      columnas: [
        { id: 'posicion', etiqueta: '#', tipo: 'numero' },
        { id: 'articulo', etiqueta: 'Artículo', tipo: 'texto' },
        { id: 'unidades', etiqueta: 'Unidades', tipo: 'numero' },
        { id: 'ingresos', etiqueta: 'Ingresos', tipo: 'dinero' },
        { id: 'margen_pct', etiqueta: 'Margen %', tipo: 'porcentaje' },
      ],
      filas,
      total_filas: filas.length,
    };
  }

  // ------------------------------------------------------------------ stock

  private estadoStock(a: Articulo): 'sin_stock' | 'bajo_minimo' | 'ok' {
    return a.existencia === 0 ? 'sin_stock' : a.existencia < a.minimo ? 'bajo_minimo' : 'ok';
  }

  private nombreProveedor(id: string): string {
    return this.datos.proveedores.find((p) => p.id === id)?.nombre ?? id;
  }

  private filasStock(articulos: Articulo[]): Obj[] {
    return articulos.map((a) => ({ articulo_id: a.id, nombre: a.nombre, categoria: a.categoria, existencia: a.existencia, minimo: a.minimo, estado: this.estadoStock(a), proveedor: this.nombreProveedor(a.proveedor_id), proveedor_id: a.proveedor_id }));
  }

  private columnasStock(): SalidaTabla['columnas'] {
    return [
      { id: 'articulo_id', etiqueta: 'Código', tipo: 'texto' },
      { id: 'nombre', etiqueta: 'Artículo', tipo: 'texto' },
      { id: 'categoria', etiqueta: 'Categoría', tipo: 'texto' },
      { id: 'existencia', etiqueta: 'Existencia', tipo: 'numero' },
      { id: 'minimo', etiqueta: 'Mínimo', tipo: 'numero' },
      { id: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      { id: 'proveedor', etiqueta: 'Proveedor', tipo: 'texto' },
    ];
  }

  listarStock(soloBajoMinimo: unknown): SalidaTabla {
    const arts = this.datos.articulos.filter((a) => soloBajoMinimo !== true || a.existencia < a.minimo);
    return { titulo: soloBajoMinimo === true ? 'Artículos bajo el mínimo' : 'Stock actual', columnas: this.columnasStock(), filas: this.filasStock(arts), total_filas: arts.length };
  }

  buscarArticulos(texto: unknown): SalidaTabla {
    const q = normalizar(String(texto ?? '')).split(/\s+/).filter(Boolean);
    if (q.length === 0) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá qué artículo buscar.');
    const arts = this.datos.articulos.filter((a) => {
      const pajar = normalizar(`${a.nombre} ${a.categoria}`);
      return q.every((p) => pajar.includes(p));
    });
    return { titulo: `Artículos que coinciden con «${String(texto)}»`, columnas: this.columnasStock(), filas: this.filasStock(arts), total_filas: arts.length };
  }

  obtenerArticulo(id: unknown): SalidaDetalle {
    const a = this.articulo(id);
    return {
      titulo: a.nombre,
      campos: [
        { etiqueta: 'Código', valor: a.id },
        { etiqueta: 'Categoría', valor: a.categoria },
        { etiqueta: 'Precio de venta', valor: fmt(a.precio) },
        { etiqueta: 'Costo', valor: fmt(a.costo) },
        { etiqueta: 'Existencia', valor: String(a.existencia) },
        { etiqueta: 'Mínimo', valor: String(a.minimo) },
        { etiqueta: 'Estado', valor: this.estadoStock(a) === 'ok' ? 'Normal' : this.estadoStock(a) === 'sin_stock' ? 'Sin stock' : 'Bajo el mínimo' },
        { etiqueta: 'Proveedor', valor: this.nombreProveedor(a.proveedor_id) },
      ],
    };
  }

  private articulo(id: unknown): Articulo {
    const a = this.datos.articulos.find((x) => x.id === id);
    if (!a) throw new ErrorErp('NO_ENCONTRADO', `No existe el artículo ${String(id)}.`, 'Buscá el artículo por nombre y probá de nuevo.');
    return a;
  }

  // ------------------------------------------------------------------ compras

  listarProveedores(): SalidaTabla {
    const filas = this.datos.proveedores.map((p) => ({ proveedor_id: p.id, nombre: p.nombre, plazo_dias: p.plazo_dias, articulos: this.datos.articulos.filter((a) => a.proveedor_id === p.id).length }));
    return {
      titulo: 'Proveedores',
      columnas: [
        { id: 'proveedor_id', etiqueta: 'Código', tipo: 'texto' },
        { id: 'nombre', etiqueta: 'Proveedor', tipo: 'texto' },
        { id: 'plazo_dias', etiqueta: 'Plazo (días)', tipo: 'numero' },
        { id: 'articulos', etiqueta: 'Artículos', tipo: 'numero' },
      ],
      filas,
      total_filas: filas.length,
    };
  }

  listarOrdenesCompra(estado: unknown): SalidaTabla {
    const ords = this.datos.ordenes.filter((o) => estado !== 'pendiente' && estado !== 'recibida' ? true : o.estado === estado);
    return {
      titulo: 'Órdenes de compra',
      columnas: [
        { id: 'orden_id', etiqueta: 'Orden', tipo: 'texto' },
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'proveedor', etiqueta: 'Proveedor', tipo: 'texto' },
        { id: 'estado', etiqueta: 'Estado', tipo: 'estado' },
        { id: 'total', etiqueta: 'Total', tipo: 'dinero' },
      ],
      filas: ords.map((o) => ({ orden_id: o.id, fecha: o.fecha, proveedor: this.nombreProveedor(o.proveedor_id), estado: o.estado, total: dinero(totalOrden(o)) })),
      total_filas: ords.length,
    };
  }

  sugerirCompra(proveedorId: unknown): SalidaTabla {
    if (proveedorId !== undefined && !this.datos.proveedores.some((p) => p.id === proveedorId)) throw new ErrorErp('NO_ENCONTRADO', `No existe el proveedor ${String(proveedorId)}.`, 'Listá los proveedores y probá de nuevo.');
    const arts = this.datos.articulos.filter((a) => a.existencia < a.minimo && (proveedorId === undefined || a.proveedor_id === proveedorId));
    const filas = arts.map((a) => {
      const sugerida = a.minimo * 2 - a.existencia;
      return { articulo_id: a.id, nombre: a.nombre, proveedor_id: a.proveedor_id, proveedor: this.nombreProveedor(a.proveedor_id), existencia: a.existencia, minimo: a.minimo, sugerida, costo_estimado: dinero(multiplicar(a.costo, String(sugerida))) };
    });
    const total = sumarCentavos(filas.map((f) => centavosDeDinero(f.costo_estimado)));
    return {
      titulo: `Compra sugerida: ${filas.length} artículos, estimado ${fmt(total)}`,
      columnas: [
        { id: 'articulo_id', etiqueta: 'Código', tipo: 'texto' },
        { id: 'nombre', etiqueta: 'Artículo', tipo: 'texto' },
        { id: 'proveedor', etiqueta: 'Proveedor', tipo: 'texto' },
        { id: 'existencia', etiqueta: 'Existencia', tipo: 'numero' },
        { id: 'minimo', etiqueta: 'Mínimo', tipo: 'numero' },
        { id: 'sugerida', etiqueta: 'Cantidad sugerida', tipo: 'numero' },
        { id: 'costo_estimado', etiqueta: 'Costo estimado', tipo: 'dinero' },
      ],
      filas,
      total_filas: filas.length,
    };
  }

  // ------------------------------------------------------------------ caja

  private fechaCaja(v: unknown): string {
    const f = v === undefined ? HOY : fechaValida(v, 'fecha');
    if (f < INICIO_DATOS || f > HOY) throw new ErrorErp('PARAMETRO_INVALIDO', `No hay datos de caja para ${f}.`, `Elegí una fecha entre ${INICIO_DATOS} y ${HOY}.`);
    return f;
  }

  private cajaDelDia(fecha: string): { apertura: number; ingresos: number; egresos: number; esperado: number; contado: number | undefined } {
    const cierre = this.cierres.find((c) => c.fecha === fecha);
    const movs = this.datos.movimientos.filter((m) => m.fecha === fecha);
    const ingresos = sumarCentavos(movs.filter((m) => m.tipo === 'ingreso').map((m) => m.importe));
    const egresos = sumarCentavos(movs.filter((m) => m.tipo === 'egreso').map((m) => m.importe));
    if (cierre) return { apertura: cierre.apertura, ingresos, egresos, esperado: cierre.apertura + ingresos - egresos, contado: cierre.contado };
    const ultimo = this.cierres[this.cierres.length - 1];
    const apertura = ultimo ? ultimo.contado : 50_000;
    return { apertura, ingresos, egresos, esperado: apertura + ingresos - egresos, contado: undefined };
  }

  estadoCaja(fechaIn: unknown): SalidaDetalle {
    const fecha = this.fechaCaja(fechaIn);
    const c = this.cajaDelDia(fecha);
    const campos = [
      { etiqueta: 'Saldo de apertura', valor: fmt(c.apertura) },
      { etiqueta: 'Ingresos', valor: fmt(c.ingresos) },
      { etiqueta: 'Egresos', valor: fmt(c.egresos) },
      { etiqueta: 'Saldo esperado', valor: fmt(c.esperado) },
    ];
    if (c.contado === undefined) campos.push({ etiqueta: 'Estado', valor: 'Caja abierta, sin arqueo' });
    else {
      campos.push({ etiqueta: 'Contado en el arqueo', valor: fmt(c.contado) }, { etiqueta: 'Diferencia', valor: fmt(c.contado - c.esperado) });
    }
    return { titulo: `Caja del ${fecha}`, campos };
  }

  listarMovimientosCaja(fechaIn: unknown): SalidaTabla {
    const fecha = this.fechaCaja(fechaIn);
    const movs = this.datos.movimientos.filter((m) => m.fecha === fecha);
    return {
      titulo: `Movimientos de caja del ${fecha}`,
      columnas: [
        { id: 'movimiento_id', etiqueta: 'Movimiento', tipo: 'texto' },
        { id: 'tipo', etiqueta: 'Tipo', tipo: 'estado' },
        { id: 'concepto', etiqueta: 'Concepto', tipo: 'texto' },
        { id: 'importe', etiqueta: 'Importe', tipo: 'dinero' },
      ],
      filas: movs.map((m) => ({ movimiento_id: m.id, tipo: m.tipo, concepto: m.concepto, importe: dinero(m.importe) })),
      total_filas: movs.length,
    };
  }

  listarArqueos(desdeIn: unknown, hastaIn: unknown): SalidaTabla {
    const desde = fechaValida(desdeIn, 'desde');
    const hasta = fechaValida(hastaIn, 'hasta');
    const cs = this.cierres.filter((c) => c.fecha >= desde && c.fecha <= hasta);
    return {
      titulo: `Arqueos de caja, ${desde} a ${hasta}`,
      columnas: [
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'esperado', etiqueta: 'Esperado', tipo: 'dinero' },
        { id: 'contado', etiqueta: 'Contado', tipo: 'dinero' },
        { id: 'diferencia', etiqueta: 'Diferencia', tipo: 'dinero' },
      ],
      filas: cs.map((c) => ({ fecha: c.fecha, esperado: dinero(c.esperado), contado: dinero(c.contado), diferencia: dinero(c.contado - c.esperado) })),
      total_filas: cs.length,
    };
  }

  // ------------------------------------------------------------------ facturación

  private cliente(id: unknown): Cliente {
    const c = this.datos.clientes.find((x) => x.id === id);
    if (!c) throw new ErrorErp('NO_ENCONTRADO', `No existe el cliente ${String(id)}.`, 'Buscá el cliente por nombre y probá de nuevo.');
    return c;
  }

  private nombreCliente(id: string): string {
    return this.datos.clientes.find((c) => c.id === id)?.nombre ?? id;
  }

  private etiquetaFactura(f: Factura): string {
    return `${f.tipo} ${f.numero}`;
  }

  private saldoCliente(clienteId: string): number {
    return sumarCentavos(this.datos.facturas.filter((f) => f.cliente_id === clienteId).map((f) => saldoDeFactura(f)));
  }

  private estadoCliente(c: Cliente): 'contado' | 'ok' | 'limite_excedido' {
    if (c.condicion_pago === 'contado') return 'contado';
    return this.saldoCliente(c.id) > c.limite_credito ? 'limite_excedido' : 'ok';
  }

  private vencida(f: Factura): boolean {
    return f.vencimiento < HOY && saldoDeFactura(f) > 0;
  }

  buscarClientes(texto: unknown): SalidaTabla {
    const q = normalizar(String(texto ?? '')).split(/\s+/).filter(Boolean);
    if (q.length === 0) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá qué cliente buscar.');
    const clientes = this.datos.clientes.filter((c) => {
      const pajar = normalizar(c.nombre);
      return q.every((p) => pajar.includes(p));
    });
    return {
      titulo: `Clientes que coinciden con «${String(texto)}»`,
      columnas: [
        { id: 'cliente_id', etiqueta: 'Código', tipo: 'texto' },
        { id: 'nombre', etiqueta: 'Cliente', tipo: 'texto' },
        { id: 'condicion_pago', etiqueta: 'Condición de pago', tipo: 'texto' },
        { id: 'limite_credito', etiqueta: 'Límite de crédito', tipo: 'dinero' },
        { id: 'saldo_pendiente', etiqueta: 'Saldo pendiente', tipo: 'dinero' },
        { id: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      ],
      filas: clientes.map((c) => ({
        cliente_id: c.id,
        nombre: c.nombre,
        condicion_pago: c.condicion_pago === 'contado' ? 'Contado' : 'Cuenta corriente',
        limite_credito: dinero(c.limite_credito),
        saldo_pendiente: dinero(this.saldoCliente(c.id)),
        estado: this.estadoCliente(c),
      })),
      total_filas: clientes.length,
    };
  }

  private filaFactura(f: Factura): Obj {
    return {
      factura_id: f.id,
      numero: this.etiquetaFactura(f),
      fecha: f.fecha,
      vencimiento: f.vencimiento,
      cliente: this.nombreCliente(f.cliente_id),
      cliente_id: f.cliente_id,
      importe: dinero(f.importe),
      saldo: dinero(saldoDeFactura(f)),
      estado: f.estado,
      vencida: this.vencida(f),
    };
  }

  listarFacturas(a: Obj): SalidaTabla {
    const cliente = a['cliente_id'] === undefined ? undefined : this.cliente(a['cliente_id']);
    const desde = a['desde'] === undefined ? undefined : fechaValida(a['desde'], 'desde');
    const hasta = a['hasta'] === undefined ? undefined : fechaValida(a['hasta'], 'hasta');
    if (desde && hasta && desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    const estado = a['estado'];
    if (estado !== undefined && !['emitida', 'anulada', 'parcialmente_cobrada', 'cobrada'].includes(String(estado))) throw new ErrorErp('PARAMETRO_INVALIDO', 'estado debe ser emitida, anulada, parcialmente_cobrada o cobrada.');
    const facturas = this.datos.facturas
      .filter((f) => (!cliente || f.cliente_id === cliente.id) && (!desde || f.fecha >= desde) && (!hasta || f.fecha <= hasta) && (estado === undefined || f.estado === estado) && (a['solo_con_saldo'] !== true || saldoDeFactura(f) > 0))
      .sort((x, y) => y.fecha.localeCompare(x.fecha) || y.numero.localeCompare(x.numero));
    const saldo = sumarCentavos(facturas.map((f) => saldoDeFactura(f)));
    return {
      titulo: `Facturas${cliente ? ` de ${cliente.nombre}` : ''}${desde || hasta ? `, ${desde ?? 'inicio'} a ${hasta ?? HOY}` : ''}: ${facturas.length}, saldo ${fmt(saldo)}`,
      columnas: [
        { id: 'numero', etiqueta: 'Comprobante', tipo: 'texto' },
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'vencimiento', etiqueta: 'Vence', tipo: 'fecha' },
        { id: 'cliente', etiqueta: 'Cliente', tipo: 'texto' },
        { id: 'importe', etiqueta: 'Importe', tipo: 'dinero' },
        { id: 'saldo', etiqueta: 'Saldo', tipo: 'dinero' },
        { id: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      ],
      filas: facturas.map((f) => this.filaFactura(f)),
      total_filas: facturas.length,
    };
  }

  private facturaPor(a: Obj): Factura {
    const numero = typeof a['numero'] === 'string' ? a['numero'].trim().replace(/^[AB]\s+/i, '') : undefined;
    if (a['factura_id'] === undefined && numero === undefined) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá factura_id o numero.');
    const f = a['factura_id'] !== undefined ? this.datos.facturas.find((x) => x.id === a['factura_id']) : this.datos.facturas.find((x) => x.numero === numero);
    if (!f) throw new ErrorErp('NO_ENCONTRADO', `No existe la factura ${String(a['factura_id'] ?? a['numero'])}.`, 'Buscá la factura por cliente o por número y probá de nuevo.');
    return f;
  }

  obtenerFactura(a: Obj): SalidaDetalle & { factura_id: string } {
    const f = this.facturaPor(a);
    const etiquetaEstado: Record<Factura['estado'], string> = { emitida: 'Emitida', anulada: 'Anulada', parcialmente_cobrada: 'Parcialmente cobrada', cobrada: 'Cobrada' };
    return {
      factura_id: f.id,
      titulo: `Factura ${this.etiquetaFactura(f)}`,
      campos: [
        { etiqueta: 'Id', valor: f.id },
        { etiqueta: 'Cliente', valor: this.nombreCliente(f.cliente_id) },
        { etiqueta: 'Fecha', valor: f.fecha },
        { etiqueta: 'Vencimiento', valor: this.vencida(f) ? `${f.vencimiento} (vencida)` : f.vencimiento },
        { etiqueta: 'Importe', valor: fmt(f.importe) },
        { etiqueta: 'Cobrado', valor: fmt(f.cobrado) },
        { etiqueta: 'Notas de crédito', valor: fmt(f.acreditado) },
        { etiqueta: 'Saldo pendiente', valor: fmt(saldoDeFactura(f)) },
        { etiqueta: 'Estado', valor: etiquetaEstado[f.estado] },
      ],
    };
  }

  /** Facturado = facturas del período que no están anuladas. Una factura anulada no cuenta, ni ella ni su nota de crédito. */
  private facturasVigentes(desde: string, hasta: string): Factura[] {
    return this.datos.facturas.filter((f) => f.fecha >= desde && f.fecha <= hasta && f.estado !== 'anulada');
  }

  private notasDelPeriodo(desde: string, hasta: string): NotaCredito[] {
    const vigentes = new Set(this.datos.facturas.filter((f) => f.estado !== 'anulada').map((f) => f.id));
    return this.datos.notasCredito.filter((n) => n.fecha >= desde && n.fecha <= hasta && vigentes.has(n.factura_id));
  }

  private cifrasFacturacion(desde: string, hasta: string): { facturado: number; notas: number; comprobantes: number; saldo: number } {
    const facturas = this.facturasVigentes(desde, hasta);
    return {
      facturado: sumarCentavos(facturas.map((f) => f.importe)),
      notas: sumarCentavos(this.notasDelPeriodo(desde, hasta).map((n) => n.importe)),
      comprobantes: facturas.length,
      saldo: sumarCentavos(facturas.map((f) => saldoDeFactura(f))),
    };
  }

  /**
   * Sin `agrupar_por` devuelve indicadores (KpiTiles) con la comparación contra el período anterior de igual duración.
   * Con `agrupar_por` (mes, cliente o tipo de comprobante) devuelve una tabla.
   */
  resumenFacturacion(desdeIn: unknown, hastaIn: unknown, agruparPor: unknown): SalidaMetricas | SalidaTabla {
    const desde = fechaValida(desdeIn, 'desde');
    const hasta = fechaValida(hastaIn, 'hasta');
    if (desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    if (agruparPor === undefined) {
      const n = diasEntre(desde, hasta);
      const antDesde = sumarDias(desde, -n);
      const antHasta = sumarDias(desde, -1);
      const actual = this.cifrasFacturacion(desde, hasta);
      const previo = antDesde >= INICIO_DATOS ? this.cifrasFacturacion(antDesde, antHasta) : undefined;
      const kpi = (id: string, etiqueta: string, tipo: 'moneda' | 'cantidad', valor: number, anterior: number | undefined, sentido: KpiMetrica['sentido_favorable']): KpiMetrica => kpiConComparacion(id, etiqueta, tipo, valor, anterior, sentido, `${antDesde} a ${antHasta}`);
      return {
        periodo: { desde, hasta, etiqueta: `${desde} a ${hasta}` },
        kpis: [
          kpi('facturado_total', 'Facturado', 'moneda', actual.facturado, previo?.facturado, 'mayor_es_mejor'),
          kpi('notas_credito_total', 'Notas de crédito', 'moneda', actual.notas, previo?.notas, 'menor_es_mejor'),
          kpi('facturado_neto', 'Facturado neto', 'moneda', actual.facturado - actual.notas, previo ? previo.facturado - previo.notas : undefined, 'mayor_es_mejor'),
          kpi('comprobantes', 'Comprobantes', 'cantidad', actual.comprobantes, previo?.comprobantes, 'mayor_es_mejor'),
          kpi('saldo_pendiente', 'Saldo pendiente de cobro', 'moneda', actual.saldo, undefined, 'menor_es_mejor'),
        ],
        fuente: { origen: 'ERP sintético (datos de ejemplo)', actualizado_en: `${HOY}T08:00:00.000Z` },
      };
    }
    const grupo = (['mes', 'cliente', 'tipo'] as const).find((g) => g === agruparPor);
    if (!grupo) throw new ErrorErp('PARAMETRO_INVALIDO', 'agrupar_por debe ser mes, cliente o tipo.');
    const acc = new Map<string, { comprobantes: number; facturado: number; saldo: number }>();
    for (const f of this.facturasVigentes(desde, hasta)) {
      const clave = grupo === 'mes' ? f.fecha.slice(0, 7) : grupo === 'cliente' ? this.nombreCliente(f.cliente_id) : `Tipo ${f.tipo}`;
      const a = acc.get(clave) ?? { comprobantes: 0, facturado: 0, saldo: 0 };
      a.comprobantes += 1;
      a.facturado += f.importe;
      a.saldo += saldoDeFactura(f);
      acc.set(clave, a);
    }
    const filas = [...acc].map(([clave, a]) => ({ grupo: clave, comprobantes: a.comprobantes, facturado: dinero(a.facturado), saldo: dinero(a.saldo) }));
    if (grupo === 'mes') filas.sort((x, y) => x.grupo.localeCompare(y.grupo));
    else filas.sort((x, y) => centavosDeDinero(y.facturado) - centavosDeDinero(x.facturado) || x.grupo.localeCompare(y.grupo));
    const nombre = grupo === 'mes' ? 'mes' : grupo === 'cliente' ? 'cliente' : 'tipo de comprobante';
    return {
      titulo: `Facturado por ${nombre}, ${desde} a ${hasta}`,
      columnas: [
        { id: 'grupo', etiqueta: grupo === 'mes' ? 'Mes' : grupo === 'cliente' ? 'Cliente' : 'Tipo', tipo: 'texto' },
        { id: 'comprobantes', etiqueta: 'Comprobantes', tipo: 'numero' },
        { id: 'facturado', etiqueta: 'Facturado', tipo: 'dinero' },
        { id: 'saldo', etiqueta: 'Saldo pendiente', tipo: 'dinero' },
      ],
      filas,
      total_filas: filas.length,
    };
  }

  // ------------------------------------------------------------------ clientes y cobranzas

  /** Días desde la emisión. La antigüedad de la deuda se cuenta desde la emisión, no desde el vencimiento. */
  private antiguedad(f: Factura): number {
    return diasEntre(f.fecha, HOY) - 1;
  }

  /** Facturas con saldo de un cliente, de la más vieja a la más nueva: es el orden en que se imputa un cobro. */
  private facturasConSaldo(clienteId: string): Factura[] {
    return this.datos.facturas.filter((f) => f.cliente_id === clienteId && saldoDeFactura(f) > 0).sort((x, y) => x.fecha.localeCompare(y.fecha) || x.numero.localeCompare(y.numero));
  }

  /** Reparte un cobro entre las facturas con saldo, empezando por la más vieja. No cambia nada. */
  private imputar(clienteId: string, importe: number): { factura: Factura; importe: number; saldoDespues: number }[] {
    let resto = importe;
    const out: { factura: Factura; importe: number; saldoDespues: number }[] = [];
    for (const f of this.facturasConSaldo(clienteId)) {
      if (resto <= 0) break;
      const saldo = saldoDeFactura(f);
      const parte = Math.min(saldo, resto);
      out.push({ factura: f, importe: parte, saldoDespues: saldo - parte });
      resto -= parte;
    }
    return out;
  }

  estadoCuentaCliente(a: Obj): SalidaDetalle & { cliente_id: string } {
    const c = this.cliente(a['cliente_id']);
    const abiertas = this.facturasConSaldo(c.id);
    const saldo = sumarCentavos(abiertas.map((f) => saldoDeFactura(f)));
    const vencido = sumarCentavos(abiertas.filter((f) => this.vencida(f)).map((f) => saldoDeFactura(f)));
    const cc = c.condicion_pago === 'cuenta_corriente';
    const campos = [
      { etiqueta: 'Cliente', valor: c.nombre },
      { etiqueta: 'Condición de pago', valor: cc ? `Cuenta corriente, ${c.plazo_dias} días` : 'Contado' },
      { etiqueta: 'Saldo pendiente', valor: fmt(saldo) },
      { etiqueta: 'Vencido', valor: fmt(vencido) },
      { etiqueta: 'A vencer', valor: fmt(saldo - vencido) },
    ];
    if (cc) {
      campos.push({ etiqueta: 'Límite de crédito', valor: fmt(c.limite_credito) });
      campos.push(saldo > c.limite_credito ? { etiqueta: 'Crédito disponible', valor: `Ninguno: excede el límite en ${fmt(saldo - c.limite_credito)}` } : { etiqueta: 'Crédito disponible', valor: fmt(c.limite_credito - saldo) });
    } else campos.push({ etiqueta: 'Límite de crédito', valor: 'No tiene (cliente de contado)' });
    campos.push({ etiqueta: 'Facturas con saldo', valor: String(abiertas.length) });
    for (const f of abiertas) campos.push({ etiqueta: `Factura ${this.etiquetaFactura(f)} (${f.fecha})`, valor: `${fmt(saldoDeFactura(f))}, ${this.vencida(f) ? `vencida el ${f.vencimiento}` : `vence el ${f.vencimiento}`}` });
    return { cliente_id: c.id, titulo: `Estado de cuenta de ${c.nombre}`, campos };
  }

  listarDeudores(a: Obj): SalidaTabla {
    const minimo = a['antiguedad_minima'] === undefined ? 0 : entero(a['antiguedad_minima'], 'antiguedad_minima', 0, 3_650);
    const orden = a['orden'] ?? 'saldo_vencido';
    if (!['saldo_vencido', 'antiguedad', 'nombre'].includes(String(orden))) throw new ErrorErp('PARAMETRO_INVALIDO', 'orden debe ser saldo_vencido, antiguedad o nombre.');
    const limite = a['limite'] === undefined ? 50 : entero(a['limite'], 'limite', 1, 50);
    const filas = this.datos.clientes
      .map((c) => {
        // Solo cuenta lo vencido y de más de `minimo` días desde la emisión.
        const vencidas = this.facturasConSaldo(c.id).filter((f) => this.vencida(f) && this.antiguedad(f) > minimo);
        const tramo = (desde: number, hasta: number): number => sumarCentavos(vencidas.filter((f) => this.antiguedad(f) >= desde && this.antiguedad(f) <= hasta).map((f) => saldoDeFactura(f)));
        return {
          c,
          vencidas,
          vencido: sumarCentavos(vencidas.map((f) => saldoDeFactura(f))),
          t030: tramo(0, 30),
          t3160: tramo(31, 60),
          t6190: tramo(61, 90),
          t90: tramo(91, Number.MAX_SAFE_INTEGER),
          maxima: Math.max(0, ...vencidas.map((f) => this.antiguedad(f))),
        };
      })
      .filter((x) => x.vencidas.length > 0)
      .sort((x, y) => (orden === 'nombre' ? x.c.nombre.localeCompare(y.c.nombre, 'es') : orden === 'antiguedad' ? y.maxima - x.maxima || y.vencido - x.vencido : y.vencido - x.vencido || x.c.nombre.localeCompare(y.c.nombre, 'es')));
    const visibles = filas.slice(0, limite);
    return {
      titulo: `Clientes con saldo vencido${minimo > 0 ? ` de más de ${minimo} días` : ''}: ${filas.length}, total vencido ${fmt(sumarCentavos(filas.map((x) => x.vencido)))}`,
      columnas: [
        { id: 'cliente_id', etiqueta: 'Código', tipo: 'texto' },
        { id: 'cliente', etiqueta: 'Cliente', tipo: 'texto' },
        { id: 'saldo_vencido', etiqueta: 'Saldo vencido', tipo: 'dinero' },
        { id: 'tramo_0_30', etiqueta: '0-30 días', tipo: 'dinero' },
        { id: 'tramo_31_60', etiqueta: '31-60 días', tipo: 'dinero' },
        { id: 'tramo_61_90', etiqueta: '61-90 días', tipo: 'dinero' },
        { id: 'tramo_mas_90', etiqueta: 'Más de 90 días', tipo: 'dinero' },
        { id: 'antiguedad_maxima', etiqueta: 'Factura más vieja (días)', tipo: 'numero' },
      ],
      filas: visibles.map((x) => ({
        cliente_id: x.c.id,
        cliente: x.c.nombre,
        saldo_vencido: dinero(x.vencido),
        tramo_0_30: dinero(x.t030),
        tramo_31_60: dinero(x.t3160),
        tramo_61_90: dinero(x.t6190),
        tramo_mas_90: dinero(x.t90),
        antiguedad_maxima: x.maxima,
      })),
      total_filas: filas.length,
    };
  }

  listarCobranzas(a: Obj): SalidaTabla {
    const cliente = a['cliente_id'] === undefined ? undefined : this.cliente(a['cliente_id']);
    const desde = a['desde'] === undefined ? undefined : fechaValida(a['desde'], 'desde');
    const hasta = a['hasta'] === undefined ? undefined : fechaValida(a['hasta'], 'hasta');
    if (desde && hasta && desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    const cobros = this.datos.cobranzas.filter((c) => (!cliente || c.cliente_id === cliente.id) && (!desde || c.fecha >= desde) && (!hasta || c.fecha <= hasta)).sort((x, y) => y.fecha.localeCompare(x.fecha) || y.numero.localeCompare(x.numero));
    return {
      titulo: `Cobranzas${cliente ? ` de ${cliente.nombre}` : ''}: ${cobros.length}, total ${fmt(sumarCentavos(cobros.map((c) => c.importe)))}`,
      columnas: [
        { id: 'numero', etiqueta: 'Recibo', tipo: 'texto' },
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'cliente', etiqueta: 'Cliente', tipo: 'texto' },
        { id: 'medio', etiqueta: 'Medio', tipo: 'texto' },
        { id: 'importe', etiqueta: 'Importe', tipo: 'dinero' },
        { id: 'facturas', etiqueta: 'Facturas', tipo: 'numero' },
      ],
      filas: cobros.map((c) => ({ cobranza_id: c.id, numero: c.numero, fecha: c.fecha, cliente: this.nombreCliente(c.cliente_id), medio: ETIQUETA_MEDIO[c.medio], importe: dinero(c.importe), facturas: c.imputaciones.length })),
      total_filas: cobros.length,
    };
  }


  // ------------------------------------------------------------------ proveedores y pagos (cuentas a pagar)

  private proveedor(id: unknown): Proveedor {
    const p = this.datos.proveedores.find((x) => x.id === id);
    if (!p) throw new ErrorErp('NO_ENCONTRADO', `No existe el proveedor ${String(id)}.`, 'Buscá el proveedor por nombre y probá de nuevo.');
    return p;
  }

  /** Domingo de la semana de HOY: «esta semana» llega hasta ahí. */
  private finDeSemana(): string {
    return sumarDias(HOY, (7 - diaDeSemana(HOY)) % 7);
  }

  private facturaProveedorPor(ref: string): FacturaProveedor | undefined {
    return this.datos.facturasProveedor.find((f) => f.id === ref || f.numero === ref);
  }

  private saldoProveedor(proveedorId: string): number {
    return sumarCentavos(this.datos.facturasProveedor.filter((f) => f.proveedor_id === proveedorId).map((f) => saldoDeFacturaProveedor(f)));
  }

  /** Facturas con saldo, la que vence primero primero: es el orden en que se imputa un pago. */
  private cuentasAbiertas(proveedorId?: string): FacturaProveedor[] {
    return this.datos.facturasProveedor
      .filter((f) => (!proveedorId || f.proveedor_id === proveedorId) && saldoDeFacturaProveedor(f) > 0)
      .sort((x, y) => x.vencimiento.localeCompare(y.vencimiento) || x.fecha.localeCompare(y.fecha) || x.numero.localeCompare(y.numero));
  }

  private situacionPago(f: FacturaProveedor): 'pagada' | 'vencida' | 'vence_hoy' | 'a_vencer' {
    if (saldoDeFacturaProveedor(f) <= 0) return 'pagada';
    return f.vencimiento < HOY ? 'vencida' : f.vencimiento === HOY ? 'vence_hoy' : 'a_vencer';
  }

  private etiquetaFacturaProveedor(f: FacturaProveedor): string {
    return f.numero;
  }

  /** Otra factura abierta del mismo proveedor con el mismo número e importe: casi seguro una carga doble. */
  private duplicadasDe(f: FacturaProveedor): FacturaProveedor[] {
    return this.datos.facturasProveedor.filter((o) => o.id !== f.id && o.proveedor_id === f.proveedor_id && o.numero === f.numero && o.importe === f.importe && saldoDeFacturaProveedor(o) > 0);
  }

  private columnasCuentasAPagar(): SalidaTabla['columnas'] {
    return [
      { id: 'factura_id', etiqueta: 'Código', tipo: 'texto' },
      { id: 'numero', etiqueta: 'Factura', tipo: 'texto' },
      { id: 'proveedor', etiqueta: 'Proveedor', tipo: 'texto' },
      { id: 'vencimiento', etiqueta: 'Vencimiento', tipo: 'fecha' },
      { id: 'importe', etiqueta: 'Importe', tipo: 'dinero' },
      { id: 'pagado', etiqueta: 'Pagado', tipo: 'dinero' },
      { id: 'saldo', etiqueta: 'Saldo', tipo: 'dinero' },
      { id: 'situacion', etiqueta: 'Situación', tipo: 'estado' },
    ];
  }

  private filaCuentaAPagar(f: FacturaProveedor): Obj {
    return { factura_id: f.id, numero: f.numero, proveedor: this.nombreProveedor(f.proveedor_id), vencimiento: f.vencimiento, importe: dinero(f.importe), pagado: dinero(f.pagado), saldo: dinero(saldoDeFacturaProveedor(f)), situacion: this.situacionPago(f) };
  }

  buscarProveedores(texto: unknown): SalidaTabla {
    const q = normalizar(String(texto ?? '')).split(/\s+/).filter(Boolean);
    if (q.length === 0) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá qué proveedor buscar.');
    const proveedores = this.datos.proveedores.filter((p) => {
      const pajar = normalizar(p.nombre);
      return q.every((x) => pajar.includes(x));
    });
    return {
      titulo: `Proveedores que coinciden con «${String(texto)}»`,
      columnas: [
        { id: 'proveedor_id', etiqueta: 'Código', tipo: 'texto' },
        { id: 'nombre', etiqueta: 'Proveedor', tipo: 'texto' },
        { id: 'plazo_dias', etiqueta: 'Plazo (días)', tipo: 'numero' },
        { id: 'saldo_pendiente', etiqueta: 'Saldo a pagar', tipo: 'dinero' },
      ],
      filas: proveedores.map((p) => ({ proveedor_id: p.id, nombre: p.nombre, plazo_dias: p.plazo_dias, saldo_pendiente: dinero(this.saldoProveedor(p.id)) })),
      total_filas: proveedores.length,
    };
  }

  listarCuentasAPagar(a: Obj): SalidaTabla {
    const prov = a['proveedor_id'] === undefined ? undefined : this.proveedor(a['proveedor_id']);
    const soloVencidas = a['solo_vencidas'] === true;
    const dias = a['vence_en_dias'] === undefined ? undefined : entero(a['vence_en_dias'], 'vence_en_dias', 0, 365);
    const limite = a['limite'] === undefined ? 50 : entero(a['limite'], 'limite', 1, 50);
    if (soloVencidas && dias !== undefined) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá solo_vencidas o vence_en_dias, no las dos.');
    const hasta = dias === undefined ? undefined : sumarDias(HOY, dias);
    const fs = this.cuentasAbiertas(prov?.id).filter((f) => (!soloVencidas || f.vencimiento < HOY) && (hasta === undefined || (f.vencimiento >= HOY && f.vencimiento <= hasta)));
    const total = sumarCentavos(fs.map((f) => saldoDeFacturaProveedor(f)));
    const filtro = soloVencidas ? ' vencidas' : hasta ? ` que vencen hasta el ${hasta}` : '';
    return {
      titulo: `Cuentas a pagar${filtro}${prov ? ` de ${prov.nombre}` : ''}: ${fs.length}, total ${fmt(total)}`,
      columnas: this.columnasCuentasAPagar(),
      filas: fs.slice(0, limite).map((f) => this.filaCuentaAPagar(f)),
      total_filas: fs.length,
    };
  }

  estadoCuentaProveedor(a: Obj): SalidaDetalle & { proveedor_id: string } {
    const p = this.proveedor(a['proveedor_id']);
    const abiertas = this.cuentasAbiertas(p.id);
    const suma = (fs: FacturaProveedor[]): number => sumarCentavos(fs.map((f) => saldoDeFacturaProveedor(f)));
    const fin = this.finDeSemana();
    const vencido = abiertas.filter((f) => f.vencimiento < HOY);
    const semana = abiertas.filter((f) => f.vencimiento >= HOY && f.vencimiento <= fin);
    const despues = abiertas.filter((f) => f.vencimiento > fin);
    const pendientesDebito = sumarCentavos(this.datos.pagosProveedor.filter((x) => x.proveedor_id === p.id && x.estado_bancario === 'pendiente_debito').map((x) => x.importe));
    const campos = [
      { etiqueta: 'Proveedor', valor: p.nombre },
      { etiqueta: 'Plazo de pago', valor: `${p.plazo_dias} días` },
      { etiqueta: 'Saldo a pagar', valor: fmt(suma(abiertas)) },
      { etiqueta: 'Vencido', valor: fmt(suma(vencido)) },
      { etiqueta: `Vence hasta el ${fin}`, valor: fmt(suma(semana)) },
      { etiqueta: 'Vence después', valor: fmt(suma(despues)) },
      { etiqueta: 'Pagos a la espera del débito bancario', valor: fmt(pendientesDebito) },
      { etiqueta: 'Facturas con saldo', valor: String(abiertas.length) },
    ];
    for (const f of abiertas) {
      const dup = this.duplicadasDe(f).length > 0 ? ', posible duplicada' : '';
      campos.push({ etiqueta: `Factura ${this.etiquetaFacturaProveedor(f)} (${f.fecha})`, valor: `${fmt(saldoDeFacturaProveedor(f))}, ${f.vencimiento < HOY ? `vencida el ${f.vencimiento}` : `vence el ${f.vencimiento}`}${dup}` });
    }
    return { proveedor_id: p.id, titulo: `Estado de cuenta de ${p.nombre}`, campos };
  }

  vencimientosProximos(a: Obj): SalidaTabla {
    const dias = a['dias'] === undefined ? 7 : entero(a['dias'], 'dias', 0, 90);
    const prov = a['proveedor_id'] === undefined ? undefined : this.proveedor(a['proveedor_id']);
    const hasta = sumarDias(HOY, dias);
    const abiertas = this.cuentasAbiertas(prov?.id);
    const fs = abiertas.filter((f) => f.vencimiento >= HOY && f.vencimiento <= hasta);
    const vencido = sumarCentavos(abiertas.filter((f) => f.vencimiento < HOY).map((f) => saldoDeFacturaProveedor(f)));
    return {
      titulo: `Pagos que vencen del ${HOY} al ${hasta}${prov ? ` de ${prov.nombre}` : ''}: ${fs.length}, total ${fmt(sumarCentavos(fs.map((f) => saldoDeFacturaProveedor(f))))}. Ya vencido y sin pagar: ${fmt(vencido)}`,
      columnas: this.columnasCuentasAPagar(),
      filas: fs.map((f) => this.filaCuentaAPagar(f)),
      total_filas: fs.length,
    };
  }

  listarPagosProveedor(a: Obj): SalidaTabla {
    const prov = a['proveedor_id'] === undefined ? undefined : this.proveedor(a['proveedor_id']);
    const desde = a['desde'] === undefined ? undefined : fechaValida(a['desde'], 'desde');
    const hasta = a['hasta'] === undefined ? undefined : fechaValida(a['hasta'], 'hasta');
    if (desde && hasta && desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    const pagos = this.datos.pagosProveedor.filter((x) => (!prov || x.proveedor_id === prov.id) && (!desde || x.fecha >= desde) && (!hasta || x.fecha <= hasta)).sort((x, y) => y.fecha.localeCompare(x.fecha) || y.numero.localeCompare(x.numero));
    return {
      titulo: `Pagos a proveedores${prov ? ` de ${prov.nombre}` : ''}: ${pagos.length}, total ${fmt(sumarCentavos(pagos.map((x) => x.importe)))}`,
      columnas: [
        { id: 'numero', etiqueta: 'Orden de pago', tipo: 'texto' },
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'proveedor', etiqueta: 'Proveedor', tipo: 'texto' },
        { id: 'medio', etiqueta: 'Medio', tipo: 'texto' },
        { id: 'importe', etiqueta: 'Importe', tipo: 'dinero' },
        { id: 'estado_bancario', etiqueta: 'Estado', tipo: 'estado' },
        { id: 'facturas', etiqueta: 'Facturas', tipo: 'numero' },
      ],
      filas: pagos.map((x) => ({ pago_id: x.id, numero: x.numero, fecha: x.fecha, proveedor: this.nombreProveedor(x.proveedor_id), medio: ETIQUETA_MEDIO_PAGO[x.medio], importe: dinero(x.importe), estado_bancario: x.estado_bancario, facturas: x.imputaciones.length })),
      total_filas: pagos.length,
    };
  }

  /** Reparte un pago entre las facturas dadas, empezando por la que vence primero. No cambia nada. */
  private imputarPago(facturas: FacturaProveedor[], importe: number): { factura: FacturaProveedor; importe: number; saldoDespues: number }[] {
    let resto = importe;
    const out: { factura: FacturaProveedor; importe: number; saldoDespues: number }[] = [];
    for (const f of facturas) {
      if (resto <= 0) break;
      const saldo = saldoDeFacturaProveedor(f);
      const parte = Math.min(saldo, resto);
      out.push({ factura: f, importe: parte, saldoDespues: saldo - parte });
      resto -= parte;
    }
    return out;
  }


  // ------------------------------------------------------------------ tesorería y bancos

  private cuenta(id: unknown): CuentaBancaria {
    const c = this.datos.cuentasBancarias.find((x) => x.id === id);
    if (!c) throw new ErrorErp('NO_ENCONTRADO', `No existe la cuenta bancaria ${String(id)}.`, 'Listá las cuentas bancarias y probá de nuevo.');
    return c;
  }

  private saldoCuenta(c: CuentaBancaria): number {
    return saldoDeCuenta(c, this.datos.movimientosBancarios);
  }

  /** Suma de los saldos de las cuentas de una moneda, en centavos de esa moneda. */
  private saldoBancos(moneda: string): number {
    return sumarCentavos(this.datos.cuentasBancarias.filter((c) => c.moneda === moneda).map((c) => this.saldoCuenta(c)));
  }

  listarCuentasBancarias(): SalidaTabla {
    const cuentas = this.datos.cuentasBancarias;
    const totales = [...new Set(cuentas.map((c) => c.moneda))].map((m) => `${m} ${dineroEn(this.saldoBancos(m), m).monto}`).join(', ');
    return {
      titulo: `Cuentas bancarias: ${cuentas.length}. Saldo total por moneda: ${totales}`,
      columnas: [
        { id: 'cuenta_id', etiqueta: 'Código', tipo: 'texto' },
        { id: 'nombre', etiqueta: 'Cuenta', tipo: 'texto' },
        { id: 'moneda', etiqueta: 'Moneda', tipo: 'texto' },
        { id: 'saldo', etiqueta: 'Saldo', tipo: 'dinero' },
      ],
      filas: cuentas.map((c) => ({ cuenta_id: c.id, nombre: c.nombre, moneda: c.moneda, saldo: dineroEn(this.saldoCuenta(c), c.moneda) })),
      total_filas: cuentas.length,
    };
  }

  listarMovimientosBancarios(a: Obj): SalidaTabla {
    const cuenta = a['cuenta_id'] === undefined ? undefined : this.cuenta(a['cuenta_id']);
    const desde = a['desde'] === undefined ? undefined : fechaValida(a['desde'], 'desde');
    const hasta = a['hasta'] === undefined ? undefined : fechaValida(a['hasta'], 'hasta');
    if (desde && hasta && desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    const tipo = a['tipo'];
    if (tipo !== undefined && !(TIPOS_MOVIMIENTO_BANCARIO as readonly unknown[]).includes(tipo)) throw new ErrorErp('PARAMETRO_INVALIDO', `tipo debe ser uno de ${TIPOS_MOVIMIENTO_BANCARIO.join(', ')}.`);
    const limite = a['limite'] === undefined ? 100 : entero(a['limite'], 'limite', 1, 200);
    const todos = this.datos.movimientosBancarios
      .filter((m) => (!cuenta || m.cuenta_id === cuenta.id) && (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta) && (tipo === undefined || m.tipo === tipo))
      .sort((x, y) => y.fecha.localeCompare(x.fecha) || y.id.localeCompare(x.id));
    const totales = [...new Set(todos.map((m) => this.cuenta(m.cuenta_id).moneda))].map((moneda) => {
      const delaMoneda = todos.filter((m) => this.cuenta(m.cuenta_id).moneda === moneda);
      const creditos = sumarCentavos(delaMoneda.filter((m) => m.sentido === 'credito').map((m) => m.importe));
      const debitos = sumarCentavos(delaMoneda.filter((m) => m.sentido === 'debito').map((m) => m.importe));
      return `${moneda} +${dineroEn(creditos, moneda).monto} -${dineroEn(debitos, moneda).monto}`;
    });
    return {
      // El título del DataTable admite hasta 120 caracteres: los totales van compactos (+ créditos, - débitos).
      titulo: `Movimientos${cuenta ? ` de ${cuenta.nombre}` : ' bancarios'}${desde || hasta ? `, ${desde ?? INICIO_DATOS} a ${hasta ?? HOY}` : ''}: ${todos.length}${totales.length ? `. ${totales.join('; ')}` : ''}`,
      columnas: [
        { id: 'movimiento_id', etiqueta: 'Movimiento', tipo: 'texto' },
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'cuenta', etiqueta: 'Cuenta', tipo: 'texto' },
        { id: 'tipo', etiqueta: 'Tipo', tipo: 'estado' },
        { id: 'concepto', etiqueta: 'Concepto', tipo: 'texto' },
        { id: 'importe', etiqueta: 'Importe', tipo: 'dinero' },
      ],
      filas: todos.slice(0, limite).map((m) => {
        const c = this.cuenta(m.cuenta_id);
        return { movimiento_id: m.id, fecha: m.fecha, cuenta: c.nombre, tipo: m.tipo, concepto: m.concepto, importe: dineroEn(m.sentido === 'credito' ? m.importe : -m.importe, c.moneda) };
      }),
      total_filas: todos.length,
    };
  }

  /**
   * Cruza TODOS los egresos «Depósito bancario» de caja con los créditos de tipo depósito del extracto. Un crédito corresponde a un
   * depósito si cae entre el día del egreso y `VENTANA_ACREDITACION_DIAS` días después. Primero se emparejan los de igual importe
   * (el crédito más antiguo primero) y, con lo que sobra, un depósito sin pareja exacta toma un crédito de otro importe de su ventana:
   * eso es una diferencia. Lo que no encuentra crédito queda pendiente. El cruce no depende del período pedido: así un crédito no se
   * le asigna a un depósito de otro día por haber acotado la búsqueda.
   */
  private cruzarDepositos(): DepositoConciliado[] {
    const depositos = this.datos.movimientos.filter((m) => m.tipo === 'egreso' && m.concepto === CONCEPTO_DEPOSITO_CAJA).sort((x, y) => x.fecha.localeCompare(y.fecha) || x.id.localeCompare(y.id));
    const creditos = this.datos.movimientosBancarios.filter((m) => m.tipo === 'deposito_caja' && m.sentido === 'credito').sort((x, y) => x.fecha.localeCompare(y.fecha) || x.id.localeCompare(y.id));
    const usados = new Set<string>();
    const pareja = new Map<string, MovimientoBancario>();
    const enVentana = (d: MovimientoCaja, c: MovimientoBancario): boolean => c.fecha >= d.fecha && c.fecha <= sumarDias(d.fecha, VENTANA_ACREDITACION_DIAS);
    for (const d of depositos) {
      const c = creditos.find((x) => !usados.has(x.id) && x.importe === d.importe && enVentana(d, x));
      if (c) {
        usados.add(c.id);
        pareja.set(d.id, c);
      }
    }
    for (const d of depositos) {
      if (pareja.has(d.id)) continue;
      const c = creditos.find((x) => !usados.has(x.id) && enVentana(d, x));
      if (c) {
        usados.add(c.id);
        pareja.set(d.id, c);
      }
    }
    return depositos.map((d) => {
      const credito = pareja.get(d.id);
      return { deposito: d, credito, estado: !credito ? 'pendiente' : credito.importe === d.importe ? 'conciliado' : 'con_diferencia' };
    });
  }

  conciliarDepositos(a: Obj): SalidaTabla {
    const desde = fechaValida(a['desde'], 'desde');
    const hasta = fechaValida(a['hasta'], 'hasta');
    if (desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    const del = this.cruzarDepositos().filter((x) => x.deposito.fecha >= desde && x.deposito.fecha <= hasta);
    const de = (estado: DepositoConciliado['estado']): DepositoConciliado[] => del.filter((x) => x.estado === estado);
    const suma = (xs: DepositoConciliado[]): number => sumarCentavos(xs.map((x) => x.deposito.importe));
    const diferencia = sumarCentavos(de('con_diferencia').map((x) => (x.credito?.importe ?? 0) - x.deposito.importe));
    const incluir = a['incluir_conciliados'] === true;
    const filas = del.filter((x) => incluir || x.estado !== 'conciliado');
    return {
      // El título del DataTable admite hasta 120 caracteres: los totales van compactos.
      titulo: `Depósitos ${desde} a ${hasta}: ${del.length}. Conciliados ${de('conciliado').length}, con diferencia ${de('con_diferencia').length} (${fmt(diferencia)}), pendientes ${de('pendiente').length} (${fmt(suma(de('pendiente')))})`,
      columnas: [
        { id: 'movimiento_caja_id', etiqueta: 'Movimiento de caja', tipo: 'texto' },
        { id: 'fecha_caja', etiqueta: 'Fecha en caja', tipo: 'fecha' },
        { id: 'importe_caja', etiqueta: 'Importe en caja', tipo: 'dinero' },
        { id: 'movimiento_bancario_id', etiqueta: 'Movimiento bancario', tipo: 'texto' },
        { id: 'fecha_banco', etiqueta: 'Fecha en el banco', tipo: 'fecha' },
        { id: 'importe_banco', etiqueta: 'Importe en el banco', tipo: 'dinero' },
        { id: 'diferencia', etiqueta: 'Diferencia', tipo: 'dinero' },
        { id: 'estado', etiqueta: 'Estado', tipo: 'estado' },
      ],
      filas: filas.map((x) => ({
        movimiento_caja_id: x.deposito.id,
        fecha_caja: x.deposito.fecha,
        importe_caja: dinero(x.deposito.importe),
        ...(x.credito ? { movimiento_bancario_id: x.credito.id, fecha_banco: x.credito.fecha, importe_banco: dinero(x.credito.importe), diferencia: dinero(x.credito.importe - x.deposito.importe) } : {}),
        estado: x.estado,
      })),
      total_filas: filas.length,
    };
  }

  /** Lo que vence entre hoy y hoy más `dias` días en las cuentas a pagar, en centavos. */
  private vencenEnDias(dias: number): number {
    const hasta = sumarDias(HOY, dias);
    return sumarCentavos(this.cuentasAbiertas().filter((f) => f.vencimiento >= HOY && f.vencimiento <= hasta).map((f) => saldoDeFacturaProveedor(f)));
  }

  posicionTesoreria(): SalidaMetricas {
    const caja = this.cajaDelDia(HOY).esperado;
    const bancosUsd = this.saldoBancos('USD');
    const bancosArs = this.saldoBancos('ARS');
    const pendienteDebito = sumarCentavos(this.datos.pagosProveedor.filter((x) => x.estado_bancario === 'pendiente_debito').map((x) => x.importe));
    const vencen = this.vencenEnDias(7);
    const disponible = caja + bancosUsd - pendienteDebito;
    const kpi = (id: string, etiqueta: string, centavos: number, moneda: string, favorable: 'mayor_es_mejor' | 'menor_es_mejor'): KpiMetrica => ({
      id,
      etiqueta,
      valor: { tipo: 'moneda', valor: dineroEn(centavos, moneda).monto, moneda },
      sentido_favorable: favorable,
    });
    return {
      periodo: { desde: HOY, hasta: HOY, etiqueta: `Al ${HOY}` },
      kpis: [
        kpi('caja', 'Caja (saldo esperado de hoy)', caja, MONEDA, 'mayor_es_mejor'),
        kpi('bancos_usd', 'Bancos en USD', bancosUsd, MONEDA, 'mayor_es_mejor'),
        kpi('pendiente_debito', 'Pagos a proveedores pendientes de débito', pendienteDebito, MONEDA, 'menor_es_mejor'),
        kpi('disponible', 'Disponible en USD (caja + bancos - pendiente de débito)', disponible, MONEDA, 'mayor_es_mejor'),
        kpi('vencen_7_dias', 'Vencimientos de proveedores en los próximos 7 días', vencen, MONEDA, 'menor_es_mejor'),
        kpi('disponible_tras_vencimientos', 'Disponible en USD después de esos vencimientos', disponible - vencen, MONEDA, 'mayor_es_mejor'),
        kpi('bancos_ars', 'Bancos en ARS (no se suma a los USD)', bancosArs, 'ARS', 'mayor_es_mejor'),
      ],
      fuente: { origen: 'ERP sintético (datos de ejemplo)', actualizado_en: `${HOY}T08:00:00.000Z` },
    };
  }


  // ------------------------------------------------------------------ precios y listas

  /** Una lista por su código o por su nombre («mayorista», «Lista Mayorista»). */
  private lista(ref: unknown): ListaPrecios {
    const q = normalizar(String(ref ?? '')).replace(/^lista\s+/, '').trim();
    const l = q ? this.datos.listasPrecios.find((x) => x.id === q || normalizar(x.nombre) === q) : undefined;
    if (!l) throw new ErrorErp('NO_ENCONTRADO', `No existe la lista de precios ${String(ref)}.`, `Las listas son: ${this.datos.listasPrecios.map((x) => x.nombre).join(', ')}.`);
    return l;
  }

  /** Precio vigente de un artículo en una lista. La Minorista es el precio del propio artículo. */
  private precioEn(lista: ListaPrecios, a: Articulo): number {
    if (lista.id === LISTA_MINORISTA) return a.precio;
    const p = this.datos.preciosLista.find((x) => x.lista_id === lista.id && x.articulo_id === a.id);
    if (!p) throw new ErrorErp('NO_ENCONTRADO', `El artículo ${a.nombre} no tiene precio en la lista ${lista.nombre}.`);
    return p.precio;
  }

  private estadoMargen(precio: number, costo: number, minimoBp: number): 'ok' | 'margen_bajo' | 'bajo_costo' {
    return precio < costo ? 'bajo_costo' : margenBp(precio, costo) < minimoBp ? 'margen_bajo' : 'ok';
  }

  private columnasPrecios(): SalidaTabla['columnas'] {
    return [
      { id: 'articulo_id', etiqueta: 'Código', tipo: 'texto' },
      { id: 'nombre', etiqueta: 'Artículo', tipo: 'texto' },
      { id: 'categoria', etiqueta: 'Categoría', tipo: 'texto' },
      { id: 'lista', etiqueta: 'Lista', tipo: 'texto' },
      { id: 'precio', etiqueta: 'Precio', tipo: 'dinero' },
      { id: 'costo', etiqueta: 'Costo', tipo: 'dinero' },
      { id: 'margen_pct', etiqueta: 'Margen %', tipo: 'porcentaje' },
      { id: 'estado', etiqueta: 'Estado', tipo: 'estado' },
    ];
  }

  private filaPrecio(lista: ListaPrecios, a: Articulo, minimoBp: number): Obj {
    const precio = this.precioEn(lista, a);
    return { articulo_id: a.id, nombre: a.nombre, categoria: a.categoria, lista: lista.nombre, precio: dinero(precio), costo: dinero(a.costo), margen_pct: textoPct(margenBp(precio, a.costo)), estado: this.estadoMargen(precio, a.costo, minimoBp) };
  }

  /** Precios vigentes por lista, categoría o artículo, con el costo y el margen calculados por el servidor. Sin lista, trae todas. */
  listarPrecios(a: Obj): SalidaTabla {
    const listas = a['lista'] === undefined ? this.datos.listasPrecios : [this.lista(a['lista'])];
    const art = a['articulo_id'] === undefined ? undefined : this.articulo(a['articulo_id']);
    const cat = a['categoria'] === undefined ? undefined : normalizar(String(a['categoria']));
    const arts = this.datos.articulos.filter((x) => (!art || x.id === art.id) && (!cat || normalizar(x.categoria) === cat));
    if (cat && arts.length === 0) throw new ErrorErp('NO_ENCONTRADO', `No hay artículos en la categoría ${String(a['categoria'])}.`, 'Las categorías son: ' + [...new Set(this.datos.articulos.map((x) => x.categoria))].join(', ') + '.');
    const filas = listas.flatMap((l) => arts.map((x) => this.filaPrecio(l, x, this.margenMinimoBp)));
    const alcance = [listas.length === 1 ? `lista ${listas[0]?.nombre}` : 'todas las listas', art ? art.nombre : undefined, cat ? String(a['categoria']) : undefined].filter(Boolean).join(', ');
    return { titulo: `Precios, ${alcance}: ${filas.length}`, columnas: this.columnasPrecios(), filas, total_filas: filas.length };
  }

  historialPrecios(a: Obj): SalidaTabla {
    const art = this.articulo(a['articulo_id']);
    const lista = a['lista'] === undefined ? undefined : this.lista(a['lista']);
    const limite = a['limite'] === undefined ? 50 : entero(a['limite'], 'limite', 1, 200);
    const todos = this.datos.cambiosPrecio.filter((c) => c.articulo_id === art.id && (!lista || c.lista_id === lista.id)).sort((x, y) => y.fecha.localeCompare(x.fecha) || y.id.localeCompare(x.id));
    return {
      titulo: `Historial de precios de ${art.nombre}${lista ? `, lista ${lista.nombre}` : ''}: ${todos.length} ${todos.length === 1 ? 'cambio' : 'cambios'}`,
      columnas: [
        { id: 'cambio_id', etiqueta: 'Cambio', tipo: 'texto' },
        { id: 'fecha', etiqueta: 'Fecha', tipo: 'fecha' },
        { id: 'lista', etiqueta: 'Lista', tipo: 'texto' },
        { id: 'precio_anterior', etiqueta: 'Precio anterior', tipo: 'dinero' },
        { id: 'precio_nuevo', etiqueta: 'Precio nuevo', tipo: 'dinero' },
        { id: 'variacion_pct', etiqueta: 'Variación %', tipo: 'porcentaje' },
        { id: 'usuario', etiqueta: 'Quién', tipo: 'texto' },
        { id: 'motivo', etiqueta: 'Motivo', tipo: 'texto' },
      ],
      filas: todos.slice(0, limite).map((c) => ({
        cambio_id: c.id,
        fecha: c.fecha,
        lista: this.lista(c.lista_id).nombre,
        precio_anterior: dinero(c.precio_anterior),
        precio_nuevo: dinero(c.precio_nuevo),
        variacion_pct: textoVariacion(Math.round(((c.precio_nuevo - c.precio_anterior) * 10_000) / c.precio_anterior)),
        usuario: c.usuario,
        motivo: c.motivo,
      })),
      total_filas: todos.length,
    };
  }

  /** Artículos cuyo margen (precio - costo) / precio en una lista queda por debajo de un mínimo, del peor al mejor. */
  articulosMargenBajo(a: Obj): SalidaTabla {
    const minimoBp = a['margen_minimo_pct'] === undefined ? this.margenMinimoBp : parsearPorcentaje(a['margen_minimo_pct'], 'margen_minimo_pct');
    if (minimoBp < 0 || minimoBp > 10_000) throw new ErrorErp('PARAMETRO_INVALIDO', 'margen_minimo_pct debe estar entre 0 y 100.');
    const listas = a['lista'] === undefined ? this.datos.listasPrecios : [this.lista(a['lista'])];
    const hallados = listas
      .flatMap((l) => this.datos.articulos.map((x) => ({ l, x, precio: this.precioEn(l, x) })))
      .filter((r) => margenBp(r.precio, r.x.costo) < minimoBp)
      .sort((p, q) => margenBp(p.precio, p.x.costo) - margenBp(q.precio, q.x.costo) || p.x.id.localeCompare(q.x.id));
    const bajoCosto = hallados.filter((r) => r.precio < r.x.costo).length;
    return {
      titulo: `Margen menor a ${textoPct(minimoBp)} %${listas.length === 1 ? `, lista ${listas[0]?.nombre}` : ''}: ${hallados.length} (${bajoCosto} bajo el costo)`,
      columnas: this.columnasPrecios(),
      filas: hallados.map((r) => this.filaPrecio(r.l, r.x, minimoBp)),
      total_filas: hallados.length,
    };
  }

  // ------------------------------------------------------------------ gestión del día (solo lectura, junta lo de las otras áreas)

  /** Saldo de una cuenta bancaria con los movimientos hasta una fecha inclusive. */
  private saldoCuentaAl(c: CuentaBancaria, fecha: string): number {
    return saldoDeCuenta(c, this.datos.movimientosBancarios.filter((m) => m.fecha <= fecha));
  }

  private totalDeVentas(fecha: string): number {
    return sumarCentavos(this.ventasEntre(fecha, fecha).map((v) => v.ingresos));
  }

  /**
   * Todo lo que hoy requiere atención, juntando lo que ya calculan las otras áreas (sin recalcularlo: se llama a sus propias funciones).
   * Prioridad alta: faltante de caja o caída de ventas grandes, depósito con diferencia, facturas de proveedor vencidas o que vencen hoy,
   * factura duplicada, cliente excedido del límite, artículo bajo el costo o sin stock. Media: lo que vence en los próximos días,
   * la deuda de clientes de más de 60 días, depósitos sin acreditar fuera de la ventana, artículos bajo el mínimo y márgenes bajos.
   * Baja: un depósito sin acreditar que todavía está dentro de la ventana de acreditación. Ordenadas por prioridad.
   */
  private alertasGestion(): AlertaGestion[] {
    const out: AlertaGestion[] = [];
    for (const a of this.detectarAnomalias(sumarDias(HOY, -(DIAS_ANOMALIAS_ALERTA - 1)), HOY).anomalias) {
      out.push({ id: a.id, prioridad: a.severidad, titulo: `${a.titulo} del ${a.fecha ?? ''}`.trim(), por_que: `${a.por_que} Observado ${a.observado}, esperado ${a.esperado}.`, area: a.id.startsWith('anom_caja_') ? 'caja' : 'ventas', referencia: a.fecha ?? a.id });
    }
    for (const x of this.cruzarDepositos()) {
      const d = x.deposito;
      if (x.estado === 'con_diferencia' && x.credito) {
        out.push({ id: `alerta_deposito_${d.id}`, prioridad: 'alta', titulo: `Depósito del ${d.fecha} acreditado con diferencia`, por_que: `En caja salió ${fmt(d.importe)} y el banco acreditó ${fmt(x.credito.importe)}: diferencia de ${fmt(x.credito.importe - d.importe)}.`, area: 'tesoreria', referencia: d.id });
      } else if (x.estado === 'pendiente') {
        const fuera = HOY > sumarDias(d.fecha, VENTANA_ACREDITACION_DIAS);
        out.push({ id: `alerta_deposito_${d.id}`, prioridad: fuera ? 'media' : 'baja', titulo: `Depósito del ${d.fecha} sin acreditar`, por_que: fuera ? `Salió de caja por ${fmt(d.importe)} y pasaron más de ${VENTANA_ACREDITACION_DIAS} días sin que el banco lo acredite.` : `Salió de caja por ${fmt(d.importe)} y todavía está dentro de los ${VENTANA_ACREDITACION_DIAS} días de acreditación.`, area: 'tesoreria', referencia: d.id });
      }
    }
    const abiertas = this.cuentasAbiertas();
    const vencidas = abiertas.filter((f) => f.vencimiento < HOY);
    if (vencidas.length > 0) {
      out.push({ id: 'alerta_facturas_proveedor_vencidas', prioridad: 'alta', titulo: `${vencidas.length} ${vencidas.length === 1 ? 'factura de proveedor vencida' : 'facturas de proveedores vencidas'} sin pagar`, por_que: `Suman ${fmt(sumarCentavos(vencidas.map((f) => saldoDeFacturaProveedor(f))))} y la más vieja venció el ${vencidas.map((f) => f.vencimiento).sort()[0]}.`, area: 'pagos', referencia: vencidas.map((f) => f.numero).join(', ') });
    }
    for (const f of abiertas.filter((x) => x.vencimiento >= HOY && x.vencimiento <= sumarDias(HOY, DIAS_VENCIMIENTO_ALERTA))) {
      const dias = diasEntre(HOY, f.vencimiento) - 1;
      out.push({ id: `alerta_vencimiento_${f.id}`, prioridad: dias === 0 ? 'alta' : 'media', titulo: `${dias === 0 ? 'Vence hoy' : `Vence el ${f.vencimiento}`} la factura ${f.numero} de ${this.nombreProveedor(f.proveedor_id)}`, por_que: `Saldo de ${fmt(saldoDeFacturaProveedor(f))}; ${dias === 0 ? 'vence hoy' : `vence en ${dias} ${dias === 1 ? 'día' : 'días'}`}.`, area: 'pagos', referencia: f.numero });
    }
    for (const f of abiertas) {
      const otras = this.duplicadasDe(f);
      if (otras.length > 0 && otras.every((o) => f.id < o.id)) {
        out.push({ id: `alerta_duplicada_${f.id}`, prioridad: 'alta', titulo: `Posible factura duplicada ${f.numero} de ${this.nombreProveedor(f.proveedor_id)}`, por_que: `Hay otra factura abierta del mismo proveedor con el mismo número e importe (${fmt(f.importe)}): casi seguro una carga doble.`, area: 'pagos', referencia: [f, ...otras].map((x) => x.id).join(' y ') });
      }
    }
    for (const c of this.datos.clientes.filter((x) => this.estadoCliente(x) === 'limite_excedido')) {
      const saldo = this.saldoCliente(c.id);
      out.push({ id: `alerta_limite_${c.id}`, prioridad: 'alta', titulo: `${c.nombre} excedió su límite de crédito`, por_que: `Debe ${fmt(saldo)} y su límite es ${fmt(c.limite_credito)}: lo excede en ${fmt(saldo - c.limite_credito)}.`, area: 'cobranzas', referencia: c.id });
    }
    for (const f of this.listarDeudores({ antiguedad_minima: DIAS_DEUDA_CLIENTE_ALERTA }).filas) {
      const saldo = f['saldo_vencido'] as Dinero;
      out.push({ id: `alerta_deuda_${String(f['cliente_id'])}`, prioridad: 'media', titulo: `${String(f['cliente'])} tiene deuda vencida de más de ${DIAS_DEUDA_CLIENTE_ALERTA} días`, por_que: `${saldo.monto} ${saldo.moneda} vencidos de más de ${DIAS_DEUDA_CLIENTE_ALERTA} días desde la emisión; la factura más vieja tiene ${String(f['antiguedad_maxima'])} días.`, area: 'cobranzas', referencia: String(f['cliente_id']) });
    }
    const bajo = this.datos.articulos.filter((a) => a.existencia < a.minimo);
    if (bajo.length > 0) {
      const sinStock = bajo.filter((a) => a.existencia === 0).length;
      out.push({ id: 'alerta_stock_bajo_minimo', prioridad: sinStock > 0 ? 'alta' : 'media', titulo: `${bajo.length} ${bajo.length === 1 ? 'artículo bajo el mínimo' : 'artículos bajo el mínimo'}${sinStock > 0 ? `, ${sinStock} sin stock` : ''}`, por_que: 'La existencia es menor al mínimo configurado de cada artículo; conviene reponer.', area: 'compras', referencia: bajo.map((a) => a.id).join(', ') });
    }
    for (const f of this.articulosMargenBajo({}).filas) {
      const precio = f['precio'] as Dinero;
      const costo = f['costo'] as Dinero;
      const bajoCosto = f['estado'] === 'bajo_costo';
      out.push({ id: `alerta_margen_${String(f['articulo_id'])}_${String(f['lista'])}`, prioridad: bajoCosto ? 'alta' : 'media', titulo: `${String(f['nombre'])} en ${String(f['lista'])}: ${bajoCosto ? 'precio bajo el costo' : 'margen bajo'}`, por_que: bajoCosto ? `El precio de ${precio.monto} ${precio.moneda} es menor que el costo de ${costo.monto} ${costo.moneda}.` : `El margen de ${String(f['margen_pct'])} % está por debajo del mínimo de ${textoPct(this.margenMinimoBp)} %.`, area: 'precios', referencia: String(f['articulo_id']) });
    }
    return out.sort((x, y) => ORDEN_PRIORIDAD[x.prioridad] - ORDEN_PRIORIDAD[y.prioridad]);
  }

  /** Lista priorizada de lo que hay que mirar hoy, con el porqué de cada alerta y el área que la resuelve. */
  alertasDelDia(): SalidaTabla {
    const alertas = this.alertasGestion();
    const n = (p: AlertaGestion['prioridad']): number => alertas.filter((a) => a.prioridad === p).length;
    return {
      titulo: `Alertas al ${HOY}: ${alertas.length} (${n('alta')} altas, ${n('media')} medias, ${n('baja')} bajas)`,
      columnas: [
        { id: 'prioridad', etiqueta: 'Prioridad', tipo: 'estado' },
        { id: 'alerta', etiqueta: 'Alerta', tipo: 'texto' },
        { id: 'por_que', etiqueta: 'Por qué', tipo: 'texto' },
        { id: 'area', etiqueta: 'Quién la resuelve', tipo: 'texto' },
        { id: 'referencia', etiqueta: 'Referencia', tipo: 'texto' },
      ],
      filas: alertas.map((a) => ({ alerta_id: a.id, prioridad: a.prioridad, alerta: a.titulo, por_que: a.por_que, area: NOMBRE_AREA[a.area] ?? a.area, referencia: a.referencia })),
      total_filas: alertas.length,
    };
  }

  /**
   * Cierre de un día (por defecto hoy): ventas contra el mismo día de la semana anterior, caja con su arqueo, cobros y pagos del día,
   * saldos bancarios a esa fecha y los pendientes para mañana (las alertas de prioridad alta y media, con el estado de hoy).
   */
  cierreDelDia(a: Obj): SalidaDetalle {
    const fecha = this.fechaCaja(a['fecha']);
    const ventas = this.totalDeVentas(fecha);
    const unidades = this.ventasEntre(fecha, fecha).reduce((s, v) => s + v.unidades, 0);
    const previa = sumarDias(fecha, -7);
    const campos: SalidaDetalle['campos'] = [{ etiqueta: 'Ventas del día', valor: `${fmt(ventas)} en ${unidades} unidades` }];
    if (previa >= INICIO_DATOS) {
      const antes = this.totalDeVentas(previa);
      campos.push({ etiqueta: `Mismo día de la semana anterior (${previa})`, valor: fmt(antes) });
      campos.push({ etiqueta: 'Variación de ventas', valor: antes === 0 ? 'Sin base de comparación' : `${(((ventas - antes) / antes) * 100).toFixed(1)} %` });
    } else campos.push({ etiqueta: 'Mismo día de la semana anterior', valor: 'Sin datos anteriores' });

    const caja = this.cajaDelDia(fecha);
    campos.push({ etiqueta: 'Caja: apertura', valor: fmt(caja.apertura) }, { etiqueta: 'Caja: ingresos', valor: fmt(caja.ingresos) }, { etiqueta: 'Caja: egresos', valor: fmt(caja.egresos) }, { etiqueta: 'Caja: saldo esperado', valor: fmt(caja.esperado) });
    if (caja.contado === undefined) campos.push({ etiqueta: 'Caja: arqueo', valor: 'Pendiente, la caja sigue abierta' });
    else campos.push({ etiqueta: 'Caja: contado en el arqueo', valor: fmt(caja.contado) }, { etiqueta: 'Caja: diferencia', valor: `${fmt(caja.contado - caja.esperado)}${caja.contado === caja.esperado ? ' (cuadra)' : ''}` });

    const cobros = this.datos.cobranzas.filter((c) => c.fecha === fecha);
    campos.push({ etiqueta: 'Cobranzas del día', valor: cobros.length === 0 ? 'Ninguna' : `${cobros.length} por ${fmt(sumarCentavos(cobros.map((c) => c.importe)))}` });
    const pagos = this.datos.pagosProveedor.filter((p) => p.fecha === fecha);
    const sinDebitar = pagos.filter((p) => p.estado_bancario === 'pendiente_debito');
    campos.push({ etiqueta: 'Pagos a proveedores del día', valor: pagos.length === 0 ? 'Ninguno' : `${pagos.length} por ${fmt(sumarCentavos(pagos.map((p) => p.importe)))}${sinDebitar.length ? `, ${sinDebitar.length} pendientes de débito bancario` : ''}` });
    for (const c of this.datos.cuentasBancarias) campos.push({ etiqueta: `Banco: ${c.nombre}`, valor: fmtEn(this.saldoCuentaAl(c, fecha), c.moneda) });

    const urgentes = this.alertasGestion().filter((x) => x.prioridad !== 'baja');
    const pendientes: string[] = [];
    if (fecha === HOY && caja.contado === undefined) pendientes.push('Caja: hacer el arqueo del día');
    for (const x of urgentes.slice(0, MAX_PENDIENTES_CIERRE)) pendientes.push(`${NOMBRE_AREA[x.area] ?? x.area}: ${x.titulo} (${x.prioridad})`);
    const total = pendientes.length + Math.max(0, urgentes.length - MAX_PENDIENTES_CIERRE);
    campos.push({ etiqueta: `Pendientes para mañana (estado al ${HOY})`, valor: total === 0 ? 'Ninguno' : String(total) });
    pendientes.forEach((p, i) => campos.push({ etiqueta: `Pendiente ${i + 1}`, valor: p }));
    if (urgentes.length > MAX_PENDIENTES_CIERRE) campos.push({ etiqueta: 'Y más', valor: `${urgentes.length - MAX_PENDIENTES_CIERRE} ${urgentes.length - MAX_PENDIENTES_CIERRE === 1 ? 'pendiente más' : 'pendientes más'} en las alertas del día` });
    return { titulo: `Cierre del ${NOMBRES_DIA[diaDeSemana(fecha)]} ${fecha}`, campos };
  }

  /** Indicadores del negocio en un período (por defecto el mes en curso hasta hoy): reutiliza los cálculos de ventas, facturación y tesorería. */
  resumenGestion(a: Obj): SalidaMetricas {
    const desde = a['desde'] === undefined ? `${HOY.slice(0, 8)}01` : fechaValida(a['desde'], 'desde');
    const hasta = a['hasta'] === undefined ? HOY : fechaValida(a['hasta'], 'hasta');
    if (desde > hasta) throw new ErrorErp('PARAMETRO_INVALIDO', 'desde no puede ser posterior a hasta.');
    const n = diasEntre(desde, hasta);
    const antDesde = sumarDias(desde, -n);
    const antHasta = sumarDias(desde, -1);
    const hayAnterior = antDesde >= INICIO_DATOS;
    const periodoAnterior = `${antDesde} a ${antHasta}`;
    const cobrado = (d: string, h: string): number => sumarCentavos(this.datos.cobranzas.filter((c) => c.fecha >= d && c.fecha <= h).map((c) => c.importe));
    const pagado = (d: string, h: string): number => sumarCentavos(this.datos.pagosProveedor.filter((p) => p.fecha >= d && p.fecha <= h).map((p) => p.importe));
    const ventasYMargen = this.consultarMetrica(['ventas_total', 'margen_bruto_pct'], desde, hasta, true).kpis;
    const facturado = (this.resumenFacturacion(desde, hasta, undefined) as SalidaMetricas).kpis.filter((k) => k.id === 'facturado_total');
    const posicion = this.posicionTesoreria().kpis.filter((k) => k.id === 'disponible' || k.id === 'bancos_ars');
    const vencidoClientes = sumarCentavos(this.datos.facturas.filter((f) => this.vencida(f)).map((f) => saldoDeFactura(f)));
    const vencidoProveedores = sumarCentavos(this.cuentasAbiertas().filter((f) => f.vencimiento < HOY).map((f) => saldoDeFacturaProveedor(f)));
    return {
      periodo: { desde, hasta, etiqueta: `${desde} a ${hasta}` },
      kpis: [
        ...ventasYMargen,
        ...facturado,
        kpiConComparacion('cobrado_total', 'Cobrado a clientes', 'moneda', cobrado(desde, hasta), hayAnterior ? cobrado(antDesde, antHasta) : undefined, 'mayor_es_mejor', periodoAnterior),
        kpiConComparacion('pagado_total', 'Pagado a proveedores', 'moneda', pagado(desde, hasta), hayAnterior ? pagado(antDesde, antHasta) : undefined, 'menor_es_mejor', periodoAnterior),
        kpiConComparacion('deuda_clientes_vencida', `Deuda vencida de clientes (al ${HOY})`, 'moneda', vencidoClientes, undefined, 'menor_es_mejor', periodoAnterior),
        kpiConComparacion('deuda_proveedores_vencida', `Deuda vencida con proveedores (al ${HOY})`, 'moneda', vencidoProveedores, undefined, 'menor_es_mejor', periodoAnterior),
        ...posicion,
      ],
      fuente: { origen: 'ERP sintético (datos de ejemplo)', actualizado_en: `${HOY}T08:00:00.000Z` },
    };
  }

  // ------------------------------------------------------------------ escrituras: preparar

  private exigirRol(tool: string, ctx: ContextoSesion): void {
    const roles = ROLES_POR_ESCRITURA[tool];
    if (roles && !roles.includes(ctx.rol)) throw new ErrorErp('PERMISO_DENEGADO', `El rol ${ctx.rol} no puede ejecutar esta operación.`, 'Pedile a un supervisor que la haga.');
  }

  private guardar(efecto: Efecto, total: Dinero | undefined, stepUp: StepUp, ctx: ContextoSesion): PropuestaGuardada {
    const id = `prop_${String(++this.contadorPropuestas).padStart(4, '0')}`;
    const p: PropuestaGuardada = { id, token: emitirToken(), expira: this.reloj().getTime() + this.vigenciaMs, efecto, total, stepUp, creador: ctx.usuario, estado: 'abierta', hashEfecto: hashPayload(efecto) };
    this.propuestas.set(id, p);
    return p;
  }

  private propuesta(p: PropuestaGuardada, base: Omit<Propuesta, 'proposal_id' | 'confirmation_token' | 'expira_en' | 'step_up' | 'requiere_step_up' | 'total'>): Propuesta {
    return {
      proposal_id: p.id,
      confirmation_token: p.token,
      expira_en: new Date(p.expira).toISOString(),
      ...base,
      ...(p.total ? { total: p.total } : {}),
      ...(p.stepUp !== 'none' ? { step_up: p.stepUp } : {}),
      // Compatibilidad con orquestadores que solo conocen requiere_step_up: motivo solo no es una autorización de otra persona.
      ...(pideSupervisor(p.stepUp) ? { requiere_step_up: true } : {}),
    };
  }

  prepararAjusteStock(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_ajuste_stock', ctx);
    const art = this.articulo(a['articulo_id']);
    const motivo = typeof a['motivo'] === 'string' ? a['motivo'].trim() : '';
    if (motivo.length < 3 || motivo.length > 120) throw new ErrorErp('PARAMETRO_INVALIDO', 'El motivo del ajuste es obligatorio (3 a 120 caracteres).', 'Preguntale a la persona el motivo.');
    let nueva: number;
    if (a['existencia_nueva'] !== undefined && a['variacion'] !== undefined) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá existencia_nueva o variacion, no las dos.');
    if (a['existencia_nueva'] !== undefined) nueva = entero(a['existencia_nueva'], 'existencia_nueva', 0, 100_000);
    else if (a['variacion'] !== undefined) nueva = art.existencia + entero(a['variacion'], 'variacion', -100_000, 100_000);
    else throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá existencia_nueva o variacion.');
    if (nueva < 0) throw new ErrorErp('PARAMETRO_INVALIDO', `La existencia no puede quedar negativa (hoy hay ${art.existencia}).`);
    const delta = nueva - art.existencia;
    if (delta === 0) throw new ErrorErp('PARAMETRO_INVALIDO', 'El ajuste no cambia la existencia.');
    const valor = multiplicar(art.costo, String(Math.abs(delta)));
    const p = this.guardar({ tipo: 'ajuste_stock', articulo_id: art.id, existencia_nueva: nueva }, dinero(valor), 'none', ctx);
    this.aud(ctx, 'preparar_ajuste_stock');
    return this.propuesta(p, {
      titulo: `Ajuste de stock: ${art.nombre}`,
      resumen: [
        { etiqueta: 'Existencia actual', valor: String(art.existencia) },
        { etiqueta: 'Existencia nueva', valor: String(nueva) },
        { etiqueta: 'Motivo', valor: motivo },
      ],
      lineas: [{ descripcion: `${art.nombre} (${delta > 0 ? 'entra' : 'sale'})`, cantidad: String(Math.abs(delta)), precio_unitario: dinero(art.costo), importe: dinero(valor) }],
    });
  }

  prepararOrdenCompra(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_orden_compra', ctx);
    const prov = this.datos.proveedores.find((p) => p.id === a['proveedor_id']);
    if (!prov) throw new ErrorErp('NO_ENCONTRADO', `No existe el proveedor ${String(a['proveedor_id'])}.`, 'Listá los proveedores y probá de nuevo.');
    if (!Array.isArray(a['items']) || a['items'].length === 0 || a['items'].length > 30) throw new ErrorErp('PARAMETRO_INVALIDO', 'items debe tener entre 1 y 30 líneas.');
    const lineas: { articulo_id: string; cantidad: number; costo_unitario: number }[] = [];
    const advertencias: string[] = [];
    for (const it of a['items'] as Obj[]) {
      const art = this.articulo(it['articulo_id']);
      if (art.proveedor_id !== prov.id) throw new ErrorErp('PARAMETRO_INVALIDO', `${art.nombre} no lo provee ${prov.nombre} (lo provee ${this.nombreProveedor(art.proveedor_id)}).`, 'Armá una orden por proveedor.');
      if (lineas.some((l) => l.articulo_id === art.id)) throw new ErrorErp('PARAMETRO_INVALIDO', `${art.nombre} está repetido en la orden.`);
      const cantidad = entero(it['cantidad'], 'cantidad', 1, 10_000);
      lineas.push({ articulo_id: art.id, cantidad, costo_unitario: art.costo });
      if (art.existencia >= art.minimo * 2) advertencias.push(`Ya hay stock de sobra de ${art.nombre} (${art.existencia}).`);
    }
    const total = sumarCentavos(lineas.map((l) => multiplicar(l.costo_unitario, String(l.cantidad))));
    const p = this.guardar({ tipo: 'orden_compra', proveedor_id: prov.id, lineas }, dinero(total), total >= UMBRAL_STEP_UP_COMPRA ? 'supervisor' : 'none', ctx);
    this.aud(ctx, 'preparar_orden_compra');
    return this.propuesta(p, {
      titulo: `Orden de compra a ${prov.nombre}`,
      resumen: [
        { etiqueta: 'Proveedor', valor: prov.nombre },
        { etiqueta: 'Plazo de entrega', valor: `${prov.plazo_dias} días` },
        { etiqueta: 'Líneas', valor: String(lineas.length) },
      ],
      lineas: lineas.map((l) => ({ descripcion: this.articulo(l.articulo_id).nombre, cantidad: String(l.cantidad), precio_unitario: dinero(l.costo_unitario), importe: dinero(multiplicar(l.costo_unitario, String(l.cantidad))) })),
      ...(advertencias.length ? { advertencias } : {}),
    });
  }

  prepararMovimientoCaja(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_movimiento_caja', ctx);
    const tipo = a['tipo'];
    if (tipo !== 'ingreso' && tipo !== 'egreso') throw new ErrorErp('PARAMETRO_INVALIDO', 'tipo debe ser ingreso o egreso.');
    const concepto = typeof a['concepto'] === 'string' ? a['concepto'].trim() : '';
    if (concepto.length < 3 || concepto.length > 80) throw new ErrorErp('PARAMETRO_INVALIDO', 'El concepto es obligatorio (3 a 80 caracteres).', 'Preguntale a la persona el concepto.');
    const importe = parsearImporte(a['importe']);
    const stepUp: StepUp = tipo === 'egreso' ? (importe >= this.umbralMotivoCaja ? 'supervisor_y_motivo' : importe >= this.umbralSupervisorCaja ? 'supervisor' : 'none') : importe >= UMBRAL_STEP_UP_CAJA ? 'motivo' : 'none';
    const p = this.guardar({ tipo: 'movimiento_caja', mov: { tipo, concepto, importe } }, dinero(importe), stepUp, ctx);
    this.aud(ctx, 'preparar_movimiento_caja');
    return this.propuesta(p, {
      titulo: `${tipo === 'egreso' ? 'Egreso' : 'Ingreso'} de caja: ${concepto}`,
      resumen: [
        { etiqueta: 'Tipo', valor: tipo === 'egreso' ? 'Egreso' : 'Ingreso' },
        { etiqueta: 'Concepto', valor: concepto },
        { etiqueta: 'Fecha', valor: HOY },
      ],
      ...(stepUp !== 'none' ? { advertencias: [this.advertenciaStepUpCaja(stepUp)] } : {}),
    });
  }

  prepararNotaCredito(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_nota_credito', ctx);
    const f = this.facturaPor({ factura_id: a['factura_id'] });
    const motivo = typeof a['motivo'] === 'string' ? a['motivo'].trim() : '';
    if (motivo.length < 3 || motivo.length > 120) throw new ErrorErp('PARAMETRO_INVALIDO', 'El motivo de la nota de crédito es obligatorio (3 a 120 caracteres).', 'Preguntale a la persona el motivo.');
    const saldo = saldoDeFactura(f);
    this.exigirAcreditable(f);
    const importe = a['importe'] === undefined ? saldo : parsearImporte(a['importe']);
    if (importe > saldo) throw new ErrorErp('IMPORTE_EXCEDE_SALDO', `El importe de la nota de crédito no puede superar el saldo de la factura (${fmt(saldo)}).`, 'Pedí un importe menor o acreditá el saldo completo.');
    const total = importe === saldo;
    const stepUp: StepUp = importe >= this.umbralNotaCredito ? 'supervisor' : 'none';
    const p = this.guardar({ tipo: 'nota_credito', factura_id: f.id, importe, motivo }, dinero(importe), stepUp, ctx);
    this.aud(ctx, 'preparar_nota_credito');
    return this.propuesta(p, {
      titulo: `Nota de crédito ${total ? 'total' : 'parcial'} sobre la factura ${this.etiquetaFactura(f)}`,
      resumen: [
        { etiqueta: 'Cliente', valor: this.nombreCliente(f.cliente_id) },
        { etiqueta: 'Factura', valor: this.etiquetaFactura(f) },
        { etiqueta: 'Saldo de la factura', valor: fmt(saldo) },
        { etiqueta: 'Saldo después de la nota', valor: fmt(saldo - importe) },
        { etiqueta: 'Motivo', valor: motivo },
      ],
      lineas: [{ descripcion: `Nota de crédito ${total ? 'total' : 'parcial'} sobre ${this.etiquetaFactura(f)}`, importe: dinero(importe) }],
      ...(stepUp !== 'none' ? { advertencias: [`Las notas de crédito de ${montoUmbral(this.umbralNotaCredito)} o más necesitan la confirmación de un supervisor.`] } : {}),
    });
  }

  prepararCobranza(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_cobranza', ctx);
    const c = this.cliente(a['cliente_id']);
    const medio = a['medio'];
    if (typeof medio !== 'string' || !(MEDIOS_COBRO as readonly string[]).includes(medio)) throw new ErrorErp('PARAMETRO_INVALIDO', 'medio debe ser efectivo, transferencia o cheque.', 'Preguntale a la persona el medio de cobro.');
    const importe = parsearImporte(a['importe']);
    const deuda = this.saldoCliente(c.id);
    if (deuda <= 0) throw new ErrorErp('SIN_DEUDA', `${c.nombre} no tiene facturas con saldo.`, 'No hay nada que imputar: un cobro sin deuda no se registra como anticipo.');
    // Un cobro mayor a la deuda se rechaza: este ejemplo no lleva saldo a favor ni anticipos.
    if (importe > deuda) throw new ErrorErp('IMPORTE_EXCEDE_DEUDA', `El cobro no puede superar lo que ${c.nombre} debe (${fmt(deuda)}).`, 'Pedí un importe menor o igual a la deuda.');
    const plan = this.imputar(c.id, importe);
    const stepUp: StepUp = importe >= this.umbralCobranza ? 'supervisor' : 'none';
    const p = this.guardar({ tipo: 'cobranza', cliente_id: c.id, medio: medio as MedioCobro, importe }, dinero(importe), stepUp, ctx);
    this.aud(ctx, 'preparar_cobranza');
    const saldadas = plan.filter((x) => x.saldoDespues === 0).length;
    const advertencias: string[] = [];
    if (medio === 'efectivo') advertencias.push('Al confirmar se registra también el ingreso en la caja de hoy.');
    if (stepUp !== 'none') advertencias.push(`Las cobranzas de ${montoUmbral(this.umbralCobranza)} o más necesitan la confirmación de un supervisor.`);
    return this.propuesta(p, {
      titulo: `Cobranza a ${c.nombre}`,
      resumen: [
        { etiqueta: 'Cliente', valor: c.nombre },
        { etiqueta: 'Medio', valor: ETIQUETA_MEDIO[medio as MedioCobro] },
        { etiqueta: 'Deuda antes del cobro', valor: fmt(deuda) },
        { etiqueta: 'Deuda después del cobro', valor: fmt(deuda - importe) },
        { etiqueta: 'Facturas que quedan cobradas', valor: `${saldadas} de ${plan.length}` },
      ],
      lineas: plan.map((x) => ({ descripcion: `Factura ${this.etiquetaFactura(x.factura)} (${x.factura.fecha}), queda ${x.saldoDespues === 0 ? 'cobrada' : `con saldo ${fmt(x.saldoDespues)}`}`, importe: dinero(x.importe) })),
      ...(advertencias.length ? { advertencias } : {}),
    });
  }


  prepararPagoProveedor(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_pago_proveedor', ctx);
    const prov = this.proveedor(a['proveedor_id']);
    const medio = a['medio'];
    if (typeof medio !== 'string' || !(MEDIOS_PAGO as readonly string[]).includes(medio)) throw new ErrorErp('PARAMETRO_INVALIDO', 'medio debe ser efectivo o transferencia.', 'Preguntale a la persona el medio de pago.');
    const refs = a['facturas'];
    const alcance = a['alcance'];
    if (refs !== undefined && alcance !== undefined) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá facturas o alcance, no los dos.');
    if (alcance !== undefined && alcance !== 'vencidas' && alcance !== 'vencen_esta_semana') throw new ErrorErp('PARAMETRO_INVALIDO', 'alcance debe ser vencidas o vencen_esta_semana.');
    if (refs === undefined && alcance === undefined && a['importe'] === undefined) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá el importe, las facturas o el alcance del pago.', 'Preguntale a la persona cuánto o qué facturas quiere pagar.');

    const abiertas = this.cuentasAbiertas(prov.id);
    let elegidas: FacturaProveedor[];
    let alcanceTexto = 'todas sus facturas con saldo';
    if (refs !== undefined) {
      if (!Array.isArray(refs) || refs.length === 0 || refs.some((r) => typeof r !== 'string')) throw new ErrorErp('PARAMETRO_INVALIDO', 'facturas debe ser una lista de códigos o números de factura.');
      const vistas = new Set<string>();
      for (const r of refs as string[]) {
        const f = this.facturaProveedorPor(r);
        if (!f) throw new ErrorErp('NO_ENCONTRADO', `No existe la factura de proveedor ${r}.`, 'Listá las cuentas a pagar del proveedor y probá de nuevo.');
        if (f.proveedor_id !== prov.id) throw new ErrorErp('PARAMETRO_INVALIDO', `La factura ${f.numero} es de ${this.nombreProveedor(f.proveedor_id)}, no de ${prov.nombre}.`);
        if (saldoDeFacturaProveedor(f) <= 0) throw new ErrorErp('FACTURA_PAGADA', `La factura ${f.numero} ya está pagada.`, 'No hay nada que imputar a esa factura.');
        vistas.add(f.id);
      }
      elegidas = abiertas.filter((f) => vistas.has(f.id));
      alcanceTexto = 'las facturas indicadas';
    } else if (alcance === 'vencidas') {
      elegidas = abiertas.filter((f) => f.vencimiento < HOY);
      alcanceTexto = 'sus facturas vencidas';
    } else if (alcance === 'vencen_esta_semana') {
      const fin = this.finDeSemana();
      elegidas = abiertas.filter((f) => f.vencimiento >= HOY && f.vencimiento <= fin);
      alcanceTexto = `sus facturas que vencen del ${HOY} al ${fin}`;
    } else elegidas = abiertas;

    const deuda = sumarCentavos(elegidas.map((f) => saldoDeFacturaProveedor(f)));
    if (deuda <= 0) throw new ErrorErp('SIN_DEUDA', `${prov.nombre} no tiene ${alcance || refs ? alcanceTexto : 'facturas'} con saldo.`, 'No hay nada para pagar con ese criterio.');
    const importe = a['importe'] === undefined ? deuda : parsearImporte(a['importe']);
    // Un pago mayor a la deuda se rechaza: este ejemplo no lleva anticipos a proveedores.
    if (importe > deuda) throw new ErrorErp('IMPORTE_EXCEDE_DEUDA', `El pago no puede superar lo que se le debe a ${prov.nombre} (${fmt(deuda)}) en ${alcanceTexto}.`, 'Pedí un importe menor o igual a la deuda.');

    const plan = this.imputarPago(elegidas, importe);
    const stepPago: StepUp = importe >= this.umbralMotivoPagoProveedor ? 'supervisor_y_motivo' : importe >= this.umbralPagoProveedor ? 'supervisor' : 'none';
    // En efectivo el pago también es un egreso de caja: rige el más estricto entre el umbral de pagos y el de caja.
    const stepCaja: StepUp = medio === 'efectivo' ? (importe >= this.umbralMotivoCaja ? 'supervisor_y_motivo' : importe >= this.umbralSupervisorCaja ? 'supervisor' : 'none') : 'none';
    const stepUp = mayorStepUp(stepPago, stepCaja);
    const p = this.guardar({ tipo: 'pago_proveedor', proveedor_id: prov.id, medio: medio as MedioPago, importe, factura_ids: elegidas.map((f) => f.id) }, dinero(importe), stepUp, ctx);
    this.aud(ctx, 'preparar_pago_proveedor');
    const saldadas = plan.filter((x) => x.saldoDespues === 0).length;
    const advertencias: string[] = [];
    if (medio === 'efectivo') advertencias.push('Al confirmar se registra también el egreso en la caja de hoy.');
    else advertencias.push('Al confirmar queda registrado como pendiente de débito bancario: el pago no se considera acreditado hasta que tesorería lo concilie.');
    if (stepPago !== 'none') advertencias.push(this.advertenciaStepUpPago(stepPago));
    if (stepCaja !== 'none') advertencias.push(this.advertenciaStepUpCaja(stepCaja));
    for (const x of plan) if (this.duplicadasDe(x.factura).length > 0) advertencias.push(`La factura ${x.factura.numero} parece estar cargada dos veces (mismo número e importe): revisala antes de pagarla.`);
    return this.propuesta(p, {
      titulo: `Pago a ${prov.nombre}`,
      resumen: [
        { etiqueta: 'Proveedor', valor: prov.nombre },
        { etiqueta: 'Medio', valor: ETIQUETA_MEDIO_PAGO[medio as MedioPago] },
        { etiqueta: 'Deuda con el proveedor antes del pago', valor: fmt(this.saldoProveedor(prov.id)) },
        { etiqueta: 'Deuda con el proveedor después del pago', valor: fmt(this.saldoProveedor(prov.id) - importe) },
        { etiqueta: 'Facturas que quedan pagadas', valor: `${saldadas} de ${plan.length}` },
      ],
      lineas: plan.map((x) => ({ descripcion: `Factura ${this.etiquetaFacturaProveedor(x.factura)} (vence el ${x.factura.vencimiento}), queda ${x.saldoDespues === 0 ? 'pagada' : `con saldo ${fmt(x.saldoDespues)}`}`, importe: dinero(x.importe) })),
      advertencias,
    });
  }

  prepararTransferenciaInterna(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_transferencia_interna', ctx);
    const origen = this.cuenta(a['cuenta_origen_id']);
    const destino = this.cuenta(a['cuenta_destino_id']);
    if (origen.id === destino.id) throw new ErrorErp('PARAMETRO_INVALIDO', 'La cuenta de origen y la de destino son la misma.', 'Preguntale a la persona a qué otra cuenta quiere transferir.');
    if (origen.moneda !== destino.moneda) throw new ErrorErp('MONEDAS_DISTINTAS', `${origen.nombre} es en ${origen.moneda} y ${destino.nombre} es en ${destino.moneda}: no se puede transferir entre monedas distintas.`, 'Este ejemplo no hace cambio de moneda: elegí dos cuentas de la misma moneda.');
    const importe = parsearImporte(a['importe']);
    const saldoOrigen = this.saldoCuenta(origen);
    if (importe > saldoOrigen) throw new ErrorErp('SALDO_INSUFICIENTE', `${origen.nombre} tiene ${fmtEn(saldoOrigen, origen.moneda)}: no alcanza para transferir ${fmtEn(importe, origen.moneda)}.`, 'Pedí un importe menor o igual al saldo de la cuenta de origen.');
    const stepUp: StepUp = importe >= this.umbralTransferenciaInterna ? 'supervisor' : 'none';
    const p = this.guardar({ tipo: 'transferencia_interna', origen_id: origen.id, destino_id: destino.id, importe }, dineroEn(importe, origen.moneda), stepUp, ctx);
    this.aud(ctx, 'preparar_transferencia_interna');
    const saldoDestino = this.saldoCuenta(destino);
    const advertencias = ['Al confirmar queda un débito en la cuenta de origen y un crédito en la de destino, con la misma fecha.'];
    if (stepUp !== 'none') advertencias.push(`Las transferencias internas de ${montoUmbral(this.umbralTransferenciaInterna)} o más necesitan la confirmación de un supervisor.`);
    return this.propuesta(p, {
      titulo: `Transferencia interna de ${origen.nombre} a ${destino.nombre}`,
      resumen: [
        { etiqueta: 'Cuenta de origen', valor: origen.nombre },
        { etiqueta: 'Cuenta de destino', valor: destino.nombre },
        { etiqueta: 'Saldo de origen antes', valor: fmtEn(saldoOrigen, origen.moneda) },
        { etiqueta: 'Saldo de origen después', valor: fmtEn(saldoOrigen - importe, origen.moneda) },
        { etiqueta: 'Saldo de destino antes', valor: fmtEn(saldoDestino, destino.moneda) },
        { etiqueta: 'Saldo de destino después', valor: fmtEn(saldoDestino + importe, destino.moneda) },
      ],
      lineas: [
        { descripcion: `Débito en ${origen.nombre}`, importe: dineroEn(importe, origen.moneda) },
        { descripcion: `Crédito en ${destino.nombre}`, importe: dineroEn(importe, destino.moneda) },
      ],
      advertencias,
    });
  }

  /**
   * Cambia el precio de uno o varios artículos en una lista. El servidor calcula los precios nuevos:
   * - `precio`: el precio nuevo es el valor tal cual lo dijo la persona.
   * - `porcentaje`: precio actual por (1 + valor / 100), redondeado al múltiplo de 5 centavos más cercano (las mitades suben).
   * - `margen`: el precio que deja ese margen sobre el costo, costo / (1 - valor / 100), redondeado hacia arriba a 5 centavos para no
   *   quedar por debajo del margen pedido.
   * Rechaza precios no positivos. Advierte (no rechaza) si algún artículo queda por debajo del costo. Pide un supervisor si algún
   * artículo cambia más del umbral de variación o si cambian más artículos que el umbral de cambio masivo, y un supervisor y el motivo
   * si algún artículo queda por debajo del costo.
   */
  prepararCambioPrecio(a: Obj, ctx: ContextoSesion): Propuesta {
    this.exigirRol('preparar_cambio_precio', ctx);
    const lista = this.lista(a['lista']);
    const modo = a['modo'];
    if (typeof modo !== 'string' || !(MODOS_CAMBIO_PRECIO as readonly string[]).includes(modo)) throw new ErrorErp('PARAMETRO_INVALIDO', 'modo debe ser precio, porcentaje o margen.', 'Preguntale a la persona cómo quiere cambiar el precio.');
    if (a['valor'] === undefined) throw new ErrorErp('PARAMETRO_INVALIDO', 'Falta el valor del cambio (el precio nuevo, el porcentaje o el margen).', 'Preguntale a la persona el valor.');
    if (a['articulo_ids'] !== undefined && a['categoria'] !== undefined) throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá articulo_ids o categoria, no los dos.');
    let arts: Articulo[];
    if (a['articulo_ids'] !== undefined) {
      const ids = a['articulo_ids'];
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((x) => typeof x !== 'string')) throw new ErrorErp('PARAMETRO_INVALIDO', 'articulo_ids debe ser una lista de entre 1 y 100 códigos de artículo.');
      if (new Set(ids).size !== ids.length) throw new ErrorErp('PARAMETRO_INVALIDO', 'articulo_ids tiene artículos repetidos.');
      arts = (ids as string[]).map((id) => this.articulo(id));
    } else if (a['categoria'] !== undefined) {
      const cat = normalizar(String(a['categoria']));
      arts = this.datos.articulos.filter((x) => normalizar(x.categoria) === cat);
      if (arts.length === 0) throw new ErrorErp('NO_ENCONTRADO', `No hay artículos en la categoría ${String(a['categoria'])}.`, 'Las categorías son: ' + [...new Set(this.datos.articulos.map((x) => x.categoria))].join(', ') + '.');
    } else throw new ErrorErp('PARAMETRO_INVALIDO', 'Indicá articulo_ids o categoria.', 'Preguntale a la persona qué artículos o qué categoría.');
    if (a['motivo'] !== undefined && (typeof a['motivo'] !== 'string' || a['motivo'].trim().length < 3 || a['motivo'].length > MAX_MOTIVO)) throw new ErrorErp('PARAMETRO_INVALIDO', `El motivo debe tener entre 3 y ${MAX_MOTIVO} caracteres.`);
    const motivo = typeof a['motivo'] === 'string' ? a['motivo'].trim() : undefined;

    const precioFijo = modo === 'precio' ? parsearImporte(a['valor']) : undefined;
    const bp = modo === 'precio' ? 0 : parsearPorcentaje(a['valor'], modo === 'margen' ? 'El margen' : 'El porcentaje');
    if (modo === 'porcentaje' && bp <= -10_000) throw new ErrorErp('PRECIO_INVALIDO', 'Una baja de 100 % o más dejaría el precio en cero o negativo.', 'Pedí una baja menor.');
    if (modo === 'margen' && (bp < 0 || bp > 9_500)) throw new ErrorErp('PARAMETRO_INVALIDO', 'El margen debe estar entre 0 y 95 %.');

    const calculados = arts.map((x) => {
      const actual = this.precioEn(lista, x);
      let nuevo: number;
      if (precioFijo !== undefined) nuevo = precioFijo;
      else if (modo === 'porcentaje') nuevo = redondear5(Math.round((actual * (10_000 + bp)) / 10_000));
      else nuevo = Math.ceil(Math.floor((x.costo * 10_000 + (10_000 - bp) - 1) / (10_000 - bp)) / 5) * 5;
      if (nuevo <= 0) throw new ErrorErp('PRECIO_INVALIDO', `El precio nuevo de ${x.nombre} no es mayor que cero.`, 'Pedí un precio o una baja menor.');
      return { x, actual, nuevo };
    });
    const cambian = calculados.filter((c) => c.nuevo !== c.actual);
    if (cambian.length === 0) throw new ErrorErp('SIN_CAMBIOS', 'Con ese valor ningún artículo cambia de precio.', 'Los precios ya están como se pidió.');
    const sinCambio = calculados.filter((c) => c.nuevo === c.actual);

    const variacion = (c: { actual: number; nuevo: number }): number => Math.round(((c.nuevo - c.actual) * 10_000) / c.actual);
    const bajoCosto = cambian.filter((c) => c.nuevo < c.x.costo);
    const grandes = cambian.filter((c) => Math.abs(variacion(c)) > this.umbralVariacionPrecioBp);
    const masivo = cambian.length > this.umbralMasivoPrecios;
    const stepUp: StepUp = bajoCosto.length > 0 ? 'supervisor_y_motivo' : grandes.length > 0 || masivo ? 'supervisor' : 'none';

    const efecto: Efecto = { tipo: 'cambio_precio', lista_id: lista.id, cambios: cambian.map((c) => ({ articulo_id: c.x.id, precio_anterior: c.actual, precio_nuevo: c.nuevo })), ...(motivo ? { motivo } : {}) };
    const p = this.guardar(efecto, undefined, stepUp, ctx);
    this.aud(ctx, 'preparar_cambio_precio');

    const advertencias: string[] = [];
    for (const c of bajoCosto) advertencias.push(`${c.x.nombre} queda por debajo del costo (${fmt(c.nuevo)} con un costo de ${fmt(c.x.costo)}).`);
    for (const c of cambian) if (c.nuevo >= c.x.costo && margenBp(c.nuevo, c.x.costo) < this.margenMinimoBp) advertencias.push(`${c.x.nombre} queda con un margen de ${textoPct(margenBp(c.nuevo, c.x.costo))} %, menor al mínimo de ${textoPct(this.margenMinimoBp)} %.`);
    if (sinCambio.length > 0) advertencias.push(`No cambian porque ya tienen ese precio: ${sinCambio.map((c) => c.x.nombre).join(', ')}.`);
    if (grandes.length > 0) advertencias.push(`Los cambios de más de ${textoPct(this.umbralVariacionPrecioBp)} % en un artículo necesitan la confirmación de un supervisor.`);
    if (masivo) advertencias.push(`Los cambios de más de ${this.umbralMasivoPrecios} artículos a la vez necesitan la confirmación de un supervisor.`);
    if (bajoCosto.length > 0) advertencias.push('Dejar un precio por debajo del costo necesita la confirmación de un supervisor y el motivo.');
    if (modo !== 'precio') advertencias.push(modo === 'porcentaje' ? 'Los precios se redondean al múltiplo de 5 centavos más cercano.' : 'Los precios se redondean hacia arriba a múltiplos de 5 centavos, para no quedar por debajo del margen pedido.');
    advertencias.push('Al confirmar rige el precio nuevo desde hoy: las ventas ya registradas no cambian.');

    return this.propuesta(p, {
      titulo: `Cambio de precios en la lista ${lista.nombre}`,
      resumen: [
        { etiqueta: 'Lista', valor: lista.nombre },
        { etiqueta: 'Cambio pedido', valor: modo === 'precio' ? `Precio nuevo de ${fmt(precioFijo as number)}` : modo === 'porcentaje' ? `${textoVariacion(bp)} %` : `Alinear al margen de ${textoPct(bp)} %` },
        { etiqueta: 'Artículos que cambian', valor: String(cambian.length) },
      ],
      lineas: cambian.map((c) => ({
        descripcion: `${c.x.nombre}: ${fmt(c.actual)} a ${fmt(c.nuevo)} (${textoVariacion(variacion(c))} %), margen ${textoPct(margenBp(c.actual, c.x.costo))} % a ${textoPct(margenBp(c.nuevo, c.x.costo))} %, costo ${fmt(c.x.costo)}`,
        precio_unitario: dinero(c.nuevo),
      })),
      advertencias,
    });
  }

  private advertenciaStepUpPago(stepUp: Exclude<StepUp, 'none'>): string {
    return stepUp === 'supervisor_y_motivo'
      ? `Los pagos a proveedores de ${montoUmbral(this.umbralMotivoPagoProveedor)} o más necesitan la confirmación de un supervisor y el motivo.`
      : `Los pagos a proveedores de ${montoUmbral(this.umbralPagoProveedor)} o más necesitan la confirmación de un supervisor.`;
  }

  /** Una factura anulada o cobrada por completo no se puede acreditar. */
  private exigirAcreditable(f: Factura): void {
    if (f.estado === 'anulada') throw new ErrorErp('FACTURA_NO_ACREDITABLE', `La factura ${this.etiquetaFactura(f)} está anulada.`, 'No hace falta otra nota de crédito sobre una factura anulada.');
    if (saldoDeFactura(f) <= 0) throw new ErrorErp('FACTURA_NO_ACREDITABLE', `La factura ${this.etiquetaFactura(f)} ya está cobrada en su totalidad.`, 'Una nota de crédito sobre una factura cobrada se resuelve con una devolución, que este agente no hace.');
  }

  // ------------------------------------------------------------------ escrituras: confirmar

  async confirmar(tool: 'ajuste_stock' | 'orden_compra' | 'movimiento_caja' | 'nota_credito' | 'cobranza' | 'pago_proveedor' | 'transferencia_interna' | 'cambio_precio', a: Obj, ctx: ContextoSesion): Promise<ConfirmarSalida> {
    this.exigirRol(`preparar_${tool}`, ctx);
    const p = typeof a['proposal_id'] === 'string' ? this.propuestas.get(a['proposal_id']) : undefined;
    if (!p || p.efecto.tipo !== tool) throw new ErrorErp('PROPUESTA_NO_ENCONTRADA', 'No existe esa propuesta.');
    const token = typeof a['confirmation_token'] === 'string' ? a['confirmation_token'] : '';
    if (!tokenCoincide(token, p.token)) throw new ErrorErp('TOKEN_INVALIDO', 'El código de confirmación no es válido.');
    const clave = typeof a['idempotency_key'] === 'string' ? a['idempotency_key'] : '';
    // Misma clave y misma entrada: se devuelve lo que se hizo la primera vez, sin repetir el efecto.
    const entrada: Obj = { tool, ...a };
    const previa = await consultarIdempotencia(this.idempotencia, ctx, clave, entrada);
    if (previa.estado === 'repetida') return { ...(previa.resultado as unknown as ConfirmarSalida), idempotente: true };
    if (previa.estado === 'conflicto') throw new ErrorErp('PARAMETRO_INVALIDO', 'La idempotency_key ya se usó con otra entrada.', 'Generá una clave nueva.');
    if (p.estado === 'confirmada') throw new ErrorErp('PROPUESTA_YA_CONFIRMADA', 'Esa propuesta ya se confirmó.');
    if (hashPayload(p.efecto) !== p.hashEfecto) throw new ErrorErp('PROPUESTA_ALTERADA', 'La propuesta guardada no coincide con la que se preparó.');
    if (p.creador !== ctx.usuario) throw new ErrorErp('PERMISO_DENEGADO', 'Solo quien preparó la propuesta puede confirmarla.');
    if (this.reloj().getTime() >= p.expira) throw new ErrorErp('PROPUESTA_EXPIRADA', 'La propuesta venció.', 'Pedí la operación de nuevo.');
    let autorizo: string | undefined;
    let motivo: string | undefined;
    if (p.stepUp !== 'none') {
      const au = esObjeto(a['autorizacion']) ? a['autorizacion'] : undefined;
      if (pideSupervisor(p.stepUp)) {
        if (!au || typeof au['usuario'] !== 'string' || typeof au['pin'] !== 'string') throw new ErrorErp('STEP_UP_REQUERIDO', 'Esta operación necesita la autorización de un supervisor.', 'Ingresá usuario y credencial de quien autoriza.');
        const reg = this.autorizadores[au['usuario']];
        const pinOk = verificarPin(au['pin'], reg?.pinHash ?? PIN_HASH_RELLENO);
        // Tiene que ser OTRA persona con rol superior: nadie se autoriza a sí mismo.
        if (!reg || !pinOk || !ROLES_AUTORIZADORES.includes(reg.rol) || au['usuario'] === ctx.usuario) throw new ErrorErp('AUTORIZACION_INVALIDA', 'Usuario o credencial de autorización incorrectos.', 'Probá de nuevo.');
        autorizo = au['usuario'];
      }
      if (pideMotivo(p.stepUp)) {
        const texto = typeof au?.['motivo'] === 'string' ? au['motivo'].trim() : '';
        if (!texto) throw new ErrorErp('STEP_UP_REQUERIDO', 'Esta operación necesita que indiques el motivo.', 'Escribí el motivo.');
        if (texto.length < 3 || texto.length > MAX_MOTIVO) throw new ErrorErp('PARAMETRO_INVALIDO', `El motivo debe tener entre 3 y ${MAX_MOTIVO} caracteres.`, 'Escribí el motivo de nuevo.');
        motivo = texto;
      }
    }

    const e = p.efecto;
    let resultado: Obj;
    let mensaje: string;
    if (e.tipo === 'ajuste_stock') {
      const art = this.articulo(e.articulo_id);
      const anterior = art.existencia;
      art.existencia = e.existencia_nueva;
      this.emitir('stock_ajustado', { articulo_id: art.id, existencia_anterior: anterior, existencia_nueva: art.existencia });
      resultado = { articulo_id: art.id, existencia_nueva: art.existencia, ...(p.total ? { total: p.total } : {}) };
      mensaje = `Stock de ${art.nombre} ajustado a ${art.existencia}.`;
    } else if (e.tipo === 'orden_compra') {
      const orden: OrdenCompra = { id: `oc_${String(this.datos.ordenes.length + 1).padStart(4, '0')}`, proveedor_id: e.proveedor_id, fecha: HOY, estado: 'pendiente', lineas: e.lineas };
      this.datos.ordenes.push(orden);
      this.emitir('orden_compra_creada', { orden_id: orden.id, proveedor_id: orden.proveedor_id, lineas: orden.lineas.length });
      resultado = { orden_id: orden.id, ...(p.total ? { total: p.total } : {}) };
      mensaje = `Orden de compra ${orden.id} creada.`;
    } else if (e.tipo === 'nota_credito') {
      const f = this.facturaPor({ factura_id: e.factura_id });
      // Entre preparar y confirmar el saldo pudo cambiar (un cobro, otra nota): se vuelve a verificar contra el estado real.
      this.exigirAcreditable(f);
      if (e.importe > saldoDeFactura(f)) throw new ErrorErp('IMPORTE_EXCEDE_SALDO', `El saldo de la factura cambió y ya no alcanza para esta nota de crédito (${fmt(saldoDeFactura(f))}).`, 'Pedí la operación de nuevo.');
      const nota: NotaCredito = {
        id: `nc_${String(this.datos.notasCredito.length + 1).padStart(4, '0')}`,
        numero: `0001-${String(1 + Math.max(0, ...this.datos.notasCredito.filter((n) => n.tipo === f.tipo).map((n) => Number(n.numero.slice(5))))).padStart(8, '0')}`,
        tipo: f.tipo,
        factura_id: f.id,
        fecha: HOY,
        importe: e.importe,
        motivo: e.motivo,
      };
      this.datos.notasCredito.push(nota);
      f.acreditado += e.importe;
      f.estado = estadoDeFactura(f);
      this.emitir('nota_credito_emitida', { nota_id: nota.id, factura_id: f.id });
      resultado = { nota_credito_id: nota.id, numero: `${nota.tipo} ${nota.numero}`, factura_id: f.id, estado_factura: f.estado, ...(p.total ? { total: p.total } : {}) };
      mensaje = `Nota de crédito ${nota.tipo} ${nota.numero} emitida sobre la factura ${this.etiquetaFactura(f)}.`;
    } else if (e.tipo === 'cobranza') {
      const cli = this.cliente(e.cliente_id);
      // Entre preparar y confirmar la deuda pudo cambiar (otro cobro, una nota de crédito): se reparte de nuevo contra el estado real.
      const deuda = this.saldoCliente(cli.id);
      if (e.importe > deuda) throw new ErrorErp('IMPORTE_EXCEDE_DEUDA', `La deuda de ${cli.nombre} cambió y ya no alcanza para este cobro (${fmt(deuda)}).`, 'Pedí la operación de nuevo.');
      const plan = this.imputar(cli.id, e.importe);
      for (const x of plan) {
        x.factura.cobrado += x.importe;
        x.factura.estado = estadoDeFactura(x.factura);
      }
      const cobro: Cobranza = {
        id: `cob_${String(this.datos.cobranzas.length + 1).padStart(4, '0')}`,
        numero: `0001-${String(this.datos.cobranzas.length + 1).padStart(8, '0')}`,
        cliente_id: cli.id,
        fecha: HOY,
        medio: e.medio,
        importe: e.importe,
        imputaciones: plan.map((x) => ({ factura_id: x.factura.id, importe: x.importe })),
      };
      this.datos.cobranzas.push(cobro);
      let movimientoId: string | undefined;
      if (e.medio === 'efectivo') {
        const mov: MovimientoCaja = { id: `mov_${String(this.datos.movimientos.length + 1).padStart(4, '0')}`, fecha: HOY, tipo: 'ingreso', concepto: `Cobranza ${cli.nombre}`.slice(0, 80), importe: e.importe };
        this.datos.movimientos.push(mov);
        movimientoId = mov.id;
        this.emitir('movimiento_caja_registrado', { movimiento_id: mov.id, tipo: mov.tipo });
      }
      this.emitir('cobranza_registrada', { cobranza_id: cobro.id, cliente_id: cli.id, medio: cobro.medio });
      resultado = {
        cobranza_id: cobro.id,
        numero: cobro.numero,
        cliente_id: cli.id,
        saldo_cliente: dinero(deuda - e.importe),
        facturas: plan.map((x) => ({ factura_id: x.factura.id, estado: x.factura.estado })),
        ...(movimientoId ? { movimiento_caja_id: movimientoId } : {}),
        ...(p.total ? { total: p.total } : {}),
      };
      mensaje = `Cobranza ${cobro.numero} registrada a ${cli.nombre}.`;
    } else if (e.tipo === 'pago_proveedor') {
      const prov = this.proveedor(e.proveedor_id);
      // Entre preparar y confirmar el saldo de esas facturas pudo cambiar (otro pago): se reparte de nuevo contra el estado real.
      const ids = new Set(e.factura_ids);
      const vigentes = this.cuentasAbiertas(prov.id).filter((f) => ids.has(f.id));
      const deuda = sumarCentavos(vigentes.map((f) => saldoDeFacturaProveedor(f)));
      if (e.importe > deuda) throw new ErrorErp('IMPORTE_EXCEDE_DEUDA', `La deuda con ${prov.nombre} cambió y ya no alcanza para este pago (${fmt(deuda)}).`, 'Pedí la operación de nuevo.');
      const plan = this.imputarPago(vigentes, e.importe);
      for (const x of plan) {
        x.factura.pagado += x.importe;
        x.factura.estado = estadoDeFacturaProveedor(x.factura);
      }
      const n = this.datos.pagosProveedor.length + 1;
      const pago: PagoProveedor = {
        id: `pag_${String(n).padStart(4, '0')}`,
        numero: `OP-${String(n).padStart(4, '0')}`,
        proveedor_id: prov.id,
        fecha: HOY,
        medio: e.medio,
        importe: e.importe,
        estado_bancario: e.medio === 'efectivo' ? 'pagado' : 'pendiente_debito',
        imputaciones: plan.map((x) => ({ factura_id: x.factura.id, importe: x.importe })),
      };
      this.datos.pagosProveedor.push(pago);
      let movimientoId: string | undefined;
      if (e.medio === 'efectivo') {
        const mov: MovimientoCaja = { id: `mov_${String(this.datos.movimientos.length + 1).padStart(4, '0')}`, fecha: HOY, tipo: 'egreso', concepto: `Pago proveedor ${prov.nombre}`.slice(0, 80), importe: e.importe };
        this.datos.movimientos.push(mov);
        movimientoId = mov.id;
        this.emitir('movimiento_caja_registrado', { movimiento_id: mov.id, tipo: mov.tipo });
      }
      this.emitir('pago_proveedor_registrado', { pago_id: pago.id, proveedor_id: prov.id, medio: pago.medio, estado_bancario: pago.estado_bancario });
      resultado = {
        pago_id: pago.id,
        numero: pago.numero,
        proveedor_id: prov.id,
        estado_bancario: pago.estado_bancario,
        saldo_proveedor: dinero(this.saldoProveedor(prov.id)),
        facturas: plan.map((x) => ({ factura_id: x.factura.id, estado: x.factura.estado })),
        ...(movimientoId ? { movimiento_caja_id: movimientoId } : {}),
        ...(p.total ? { total: p.total } : {}),
      };
      mensaje = `Pago ${pago.numero} registrado a ${prov.nombre}.${pago.estado_bancario === 'pendiente_debito' ? ' Queda pendiente de débito bancario.' : ''}`;
    } else if (e.tipo === 'transferencia_interna') {
      const origen = this.cuenta(e.origen_id);
      const destino = this.cuenta(e.destino_id);
      // Entre preparar y confirmar el saldo pudo bajar (otra transferencia, un débito): se verifica contra el estado real.
      const saldoOrigen = this.saldoCuenta(origen);
      if (e.importe > saldoOrigen) throw new ErrorErp('SALDO_INSUFICIENTE', `El saldo de ${origen.nombre} cambió y ya no alcanza para esta transferencia (${fmtEn(saldoOrigen, origen.moneda)}).`, 'Pedí la operación de nuevo.');
      const n = this.datos.transferenciasInternas.length + 1;
      const transferencia: TransferenciaInterna = { id: `tri_${String(n).padStart(4, '0')}`, numero: `TI-${String(n).padStart(4, '0')}`, fecha: HOY, origen_id: origen.id, destino_id: destino.id, importe: e.importe };
      this.datos.transferenciasInternas.push(transferencia);
      const proximo = this.datos.movimientosBancarios.length + 1;
      const debito: MovimientoBancario = { id: `mba_${String(proximo).padStart(4, '0')}`, cuenta_id: origen.id, fecha: HOY, sentido: 'debito', tipo: 'transferencia_interna', concepto: `Transferencia interna ${transferencia.numero} a ${destino.nombre}`, importe: e.importe };
      const credito: MovimientoBancario = { id: `mba_${String(proximo + 1).padStart(4, '0')}`, cuenta_id: destino.id, fecha: HOY, sentido: 'credito', tipo: 'transferencia_interna', concepto: `Transferencia interna ${transferencia.numero} desde ${origen.nombre}`, importe: e.importe };
      this.datos.movimientosBancarios.push(debito, credito);
      this.emitir('transferencia_interna_registrada', { transferencia_id: transferencia.id, origen_id: origen.id, destino_id: destino.id });
      resultado = {
        transferencia_id: transferencia.id,
        numero: transferencia.numero,
        saldo_origen: dineroEn(this.saldoCuenta(origen), origen.moneda),
        saldo_destino: dineroEn(this.saldoCuenta(destino), destino.moneda),
        movimientos_bancarios: [debito.id, credito.id],
        ...(p.total ? { total: p.total } : {}),
      };
      mensaje = `Transferencia interna ${transferencia.numero} registrada de ${origen.nombre} a ${destino.nombre}.`;
    } else if (e.tipo === 'cambio_precio') {
      const lista = this.lista(e.lista_id);
      // Entre preparar y confirmar el precio pudo cambiar (otro cambio): se verifica contra el estado real.
      for (const c of e.cambios) {
        const actual = this.precioEn(lista, this.articulo(c.articulo_id));
        if (actual !== c.precio_anterior) throw new ErrorErp('PRECIO_CAMBIADO', `El precio de ${this.articulo(c.articulo_id).nombre} cambió desde que se preparó (ahora ${fmt(actual)}).`, 'Pedí la operación de nuevo.');
      }
      const registrados: CambioPrecio[] = [];
      for (const c of e.cambios) {
        const art = this.articulo(c.articulo_id);
        if (lista.id === LISTA_MINORISTA) art.precio = c.precio_nuevo;
        else {
          const fila = this.datos.preciosLista.find((x) => x.lista_id === lista.id && x.articulo_id === art.id);
          if (!fila) throw new ErrorErp('NO_ENCONTRADO', `El artículo ${art.nombre} no tiene precio en la lista ${lista.nombre}.`);
          fila.precio = c.precio_nuevo;
        }
        const cambio: CambioPrecio = { id: `cpr_${String(this.datos.cambiosPrecio.length + 1).padStart(4, '0')}`, articulo_id: art.id, lista_id: lista.id, precio_anterior: c.precio_anterior, precio_nuevo: c.precio_nuevo, fecha: HOY, usuario: ctx.usuario, motivo: motivo ?? e.motivo ?? 'Sin motivo indicado' };
        this.datos.cambiosPrecio.push(cambio);
        registrados.push(cambio);
      }
      this.emitir('precios_modificados', { lista_id: lista.id, articulos: registrados.length });
      resultado = { lista_id: lista.id, cambios: registrados.map((c) => ({ cambio_id: c.id, articulo_id: c.articulo_id, precio_nuevo: dinero(c.precio_nuevo) })) };
      mensaje = `Precios actualizados en la lista ${lista.nombre}: ${registrados.length} ${registrados.length === 1 ? 'artículo' : 'artículos'}.`;
    } else {
      const mov: MovimientoCaja = { id: `mov_${String(this.datos.movimientos.length + 1).padStart(4, '0')}`, fecha: HOY, ...e.mov };
      this.datos.movimientos.push(mov);
      this.emitir('movimiento_caja_registrado', { movimiento_id: mov.id, tipo: mov.tipo });
      resultado = { movimiento_id: mov.id, ...(p.total ? { total: p.total } : {}) };
      mensaje = `${mov.tipo === 'egreso' ? 'Egreso' : 'Ingreso'} de caja registrado.`;
    }
    const salida: ConfirmarSalida = { estado: 'confirmado', proposal_id: p.id, idempotente: false, resultado, mensaje };
    p.estado = 'confirmada';
    await registrarIdempotencia(this.idempotencia, ctx, clave, entrada, salida as unknown as Obj);
    this.aud(ctx, `confirmar_${tool}`, autorizo, motivo);
    return salida;
  }
}

/** El nivel de step-up que cumple los dos: pide supervisor si alguno lo pide y motivo si alguno lo pide. */
function mayorStepUp(a: StepUp, b: StepUp): StepUp {
  const supervisor = pideSupervisor(a) || pideSupervisor(b);
  const motivo = pideMotivo(a) || pideMotivo(b);
  return supervisor && motivo ? 'supervisor_y_motivo' : supervisor ? 'supervisor' : motivo ? 'motivo' : 'none';
}

function totalOrden(o: OrdenCompra): number {
  return sumarCentavos(o.lineas.map((l) => multiplicar(l.costo_unitario, String(l.cantidad))));
}

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
