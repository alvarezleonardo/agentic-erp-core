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
import { ANOMALIA_CAJA, HOY, INICIO_DATOS, MONEDA, generarDatos, type Articulo, type DatosErp, type MovimientoCaja, type OrdenCompra } from './datos.js';
import { diaDeSemana, diasEntre, esFecha, rango, sumarDias } from './fechas.js';
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
}

type Efecto =
  | { tipo: 'ajuste_stock'; articulo_id: string; existencia_nueva: number }
  | { tipo: 'orden_compra'; proveedor_id: string; lineas: { articulo_id: string; cantidad: number; costo_unitario: number }[] }
  | { tipo: 'movimiento_caja'; mov: Omit<MovimientoCaja, 'id' | 'fecha'> };

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

export const METRICAS: DefMetrica[] = [
  { id: 'ventas_total', etiqueta: 'Ventas', descripcion: 'Ingresos por ventas en el período, todos los canales.', tipo: 'moneda', dimensiones: ['dia', 'articulo', 'categoria', 'canal'], sentido_favorable: 'mayor_es_mejor' },
  { id: 'unidades_vendidas', etiqueta: 'Unidades vendidas', descripcion: 'Unidades vendidas en el período.', tipo: 'cantidad', dimensiones: ['dia', 'articulo', 'categoria', 'canal'], sentido_favorable: 'mayor_es_mejor' },
  { id: 'margen_bruto_pct', etiqueta: 'Margen bruto', descripcion: 'Ventas menos costo de lo vendido, sobre ventas.', tipo: 'porcentaje', dimensiones: ['dia', 'categoria'], sentido_favorable: 'mayor_es_mejor' },
  { id: 'compras_total', etiqueta: 'Compras', descripcion: 'Total de órdenes de compra emitidas en el período.', tipo: 'moneda', dimensiones: ['proveedor'], sentido_favorable: 'menor_es_mejor' },
  { id: 'faltante_caja', etiqueta: 'Faltante de caja', descripcion: 'Suma de lo que faltó en los arqueos del período (esperado menos contado, solo faltantes).', tipo: 'moneda', dimensiones: ['dia'], sentido_favorable: 'menor_es_mejor' },
];

const ADVERTENCIA_STEP_UP: Readonly<Record<Exclude<StepUp, 'none'>, string>> = {
  motivo: 'Los ingresos de 500.00 o más necesitan que indiques el motivo.',
  supervisor: 'Los egresos de 500.00 o más necesitan la autorización de un supervisor.',
  supervisor_y_motivo: 'Los egresos de 2000.00 o más necesitan la autorización de un supervisor y el motivo.',
};

/** Hash de relleno: verificar contra algo cuando el usuario no existe evita que el tiempo de respuesta delate qué usuarios hay. */
const PIN_HASH_RELLENO = hashPin('relleno');

const normalizar = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmt = (centavos: number): string => {
  const d = dineroDeCentavos(centavos, MONEDA);
  return `${d.monto} ${d.moneda}`;
};
const dinero = (c: number): Dinero => dineroDeCentavos(c, MONEDA);

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
  /** Los PIN se guardan con scrypt (`hashPin`), nunca en claro. */
  private readonly autorizadores: Record<string, { pinHash: string; rol: string }>;
  private readonly vigenciaMs: number;
  private readonly idempotencia: RegistroIdempotencia;
  private readonly umbralSupervisorCaja: number;
  private readonly umbralMotivoCaja: number;

  constructor(o: OpcionesErp = {}) {
    this.datos = o.datos ?? generarDatos();
    this.reloj = o.reloj ?? (() => new Date());
    this.autorizadores = Object.fromEntries(Object.entries(o.autorizadores ?? {}).map(([usuario, a]) => [usuario, { pinHash: hashPin(a.pin), rol: a.rol }]));
    this.vigenciaMs = (o.vigenciaMin ?? 10) * 60_000;
    this.idempotencia = o.idempotencia ?? new RegistroIdempotenciaMemoria();
    this.umbralSupervisorCaja = o.umbralesCaja?.supervisor ?? UMBRAL_STEP_UP_CAJA;
    this.umbralMotivoCaja = o.umbralesCaja?.supervisorYMotivo ?? UMBRAL_MOTIVO_CAJA;
    this.cierres = this.calcularCierres();
    this.sembrarEventos();
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
      ...(stepUp !== 'none' ? { advertencias: [ADVERTENCIA_STEP_UP[stepUp]] } : {}),
    });
  }

  // ------------------------------------------------------------------ escrituras: confirmar

  async confirmar(tool: 'ajuste_stock' | 'orden_compra' | 'movimiento_caja', a: Obj, ctx: ContextoSesion): Promise<ConfirmarSalida> {
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
        if (!au || typeof au['usuario'] !== 'string' || typeof au['pin'] !== 'string') throw new ErrorErp('STEP_UP_REQUERIDO', 'Esta operación necesita la autorización de un supervisor.', 'Ingresá usuario y PIN de quien autoriza.');
        const reg = this.autorizadores[au['usuario']];
        const pinOk = verificarPin(au['pin'], reg?.pinHash ?? PIN_HASH_RELLENO);
        // Tiene que ser OTRA persona con rol superior: nadie se autoriza a sí mismo.
        if (!reg || !pinOk || !ROLES_AUTORIZADORES.includes(reg.rol) || au['usuario'] === ctx.usuario) throw new ErrorErp('AUTORIZACION_INVALIDA', 'Usuario o PIN de autorización incorrectos.', 'Probá de nuevo.');
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

function totalOrden(o: OrdenCompra): number {
  return sumarCentavos(o.lineas.map((l) => multiplicar(l.costo_unitario, String(l.cantidad))));
}

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
