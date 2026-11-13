/** Tipos del contrato MCP que un ERP expone al orquestador. Ver CONTRACT.md. */

export type Obj = Record<string, unknown>;

export const esObjeto = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Identidad de la sesión: la fija el orquestador en cada llamada, nunca el modelo. */
export interface ContextoSesion {
  tenant: string;
  usuario: string;
  /** Rol del ERP (el contrato no fija los nombres: los define cada ERP). */
  rol: string;
  sucursal?: string;
  /** Quién origina la escritura, para auditoría: `humano` al confirmar, `agente` al preparar. */
  origen?: 'humano' | 'agente';
}

/** Importe monetario: string decimal con dos decimales. Nunca lo calcula el modelo. */
export interface Dinero {
  monto: string;
  moneda: string;
}

/** Un tool tal como lo publica el servidor MCP. */
export interface ToolMcp {
  nombre: string;
  descripcion: string;
  /** JSON Schema completo de la entrada (incluye `contexto`). */
  esquema: Obj;
}

export interface ResultadoTool {
  ok: boolean;
  /** JSON del tool; con ok=false es un ErrorTool ({ codigo, mensaje, accion_sugerida? }). */
  datos: Obj;
}

/** Puerto que usa el orquestador para hablar con uno o varios servidores MCP (permite dobles de prueba). */
export interface ToolClient {
  listarTools(): Promise<ToolMcp[]>;
  /** `contexto` undefined = tool que corre antes de tener sesión. */
  llamar(nombre: string, args: Obj, contexto: ContextoSesion | undefined): Promise<ResultadoTool>;
  cerrar(): Promise<void>;
}

export interface ErrorTool {
  codigo: string;
  mensaje: string;
  accion_sugerida?: string;
}

// ---------- Escrituras: preparar / confirmar ----------

export interface ParEtiquetaValor {
  etiqueta: string;
  valor: string;
}

export interface LineaPropuesta {
  descripcion: string;
  cantidad?: string;
  precio_unitario?: Dinero;
  importe?: Dinero;
}

/** Salida de todo `preparar_*`: nada se ejecutó todavía. */
export interface Propuesta {
  proposal_id: string;
  /** Secreto de un solo uso. Lo ve la superficie, nunca el modelo. */
  confirmation_token: string;
  /** ISO 8601. */
  expira_en: string;
  titulo: string;
  resumen?: ParEtiquetaValor[];
  lineas?: LineaPropuesta[];
  /** Total calculado por el servidor. */
  total?: Dinero;
  advertencias?: string[];
  /**
   * Qué pide la confirmación además del token (step-up). Sin este campo vale `requiere_step_up`:
   * `true` equivale a `supervisor` y `false` o ausente a `none`.
   */
  step_up?: StepUp;
  /** Compatibilidad: `true` equivale a `step_up: 'supervisor'`. Un servidor nuevo puede enviar los dos. */
  requiere_step_up?: boolean;
}

/**
 * Nivel de step-up de una confirmación:
 * - `none`: alcanza con el toque de la persona.
 * - `motivo`: la persona escribe un texto obligatorio.
 * - `supervisor`: usuario y PIN de otra persona con rol superior.
 * - `supervisor_y_motivo`: las dos cosas.
 */
export type StepUp = 'none' | 'motivo' | 'supervisor' | 'supervisor_y_motivo';

/**
 * Lo que viaja de la pantalla al servidor dentro de `confirmar_*`. Nunca pasa por el modelo ni por las trazas
 * (el PIN); el motivo sí puede quedar en auditoría y trazas.
 */
export interface Autorizacion {
  /** Quien autoriza (step-up `supervisor`). */
  usuario?: string;
  /** PIN de quien autoriza. Lo verifica el servidor; el orquestador solo lo transporta. */
  pin?: string;
  /** Texto de la persona (step-up `motivo`). */
  motivo?: string;
}

/** Entrada de todo `confirmar_*`. */
export interface ConfirmarEntrada {
  contexto: ContextoSesion;
  proposal_id: string;
  confirmation_token: string;
  /** Misma clave = mismo resultado, sin repetir el efecto. */
  idempotency_key: string;
  autorizacion?: Autorizacion;
}

export interface ConfirmarSalida {
  estado: 'confirmado';
  proposal_id: string;
  /** true si es la repetición de una confirmación ya aplicada. */
  idempotente: boolean;
  /** Lo que produjo la operación (ids, número de documento...). */
  resultado: Obj;
  mensaje?: string;
}

// ---------- Eventos con cursor ----------

export interface EventoErp {
  /** Monótona creciente por tenant. */
  secuencia: number;
  tipo: string;
  ocurrido_en: string;
  /** Proyección mínima: ids y datos no sensibles. */
  payload: Obj;
}

export interface ConsumirEventosEntrada {
  contexto: ContextoSesion;
  /** Sin cursor no devuelve eventos: responde la posición actual en `siguiente`. */
  desde_secuencia?: number;
  tipos?: string[];
  limite?: number;
}

export interface ConsumirEventosSalida {
  eventos: EventoErp[];
  siguiente: number;
}

// ---------- Métricas semánticas ----------

export type TipoValor = 'moneda' | 'cantidad' | 'porcentaje' | 'minutos';

export interface DefMetrica {
  id: string;
  etiqueta: string;
  descripcion: string;
  tipo: TipoValor;
  dimensiones: string[];
  sentido_favorable: 'mayor_es_mejor' | 'menor_es_mejor';
}

export interface Periodo {
  desde: string;
  hasta: string;
  etiqueta?: string;
}

export interface ValorMetrica {
  tipo: TipoValor;
  valor: string;
  moneda?: string;
}

export interface KpiMetrica {
  id: string;
  etiqueta: string;
  valor: ValorMetrica;
  comparacion?: { variacion_pct: string; periodo_anterior?: string; valor_anterior?: ValorMetrica };
  tendencia?: 'sube' | 'baja' | 'estable';
  sentido_favorable?: 'mayor_es_mejor' | 'menor_es_mejor';
}

/** Salida de `consultar_metrica`. */
export interface SalidaMetricas {
  periodo: Periodo;
  kpis: KpiMetrica[];
  fuente?: { origen: string; actualizado_en?: string };
}

// ---------- Formas de lectura que la capa de vistas sabe mostrar ----------

export interface ColumnaTabla {
  id: string;
  etiqueta: string;
  tipo?: 'texto' | 'numero' | 'dinero' | 'fecha' | 'porcentaje' | 'estado';
}

/** Lectura tabular: se muestra con el componente DataTable. */
export interface SalidaTabla {
  titulo?: string;
  columnas: ColumnaTabla[];
  filas: Obj[];
  total_filas?: number;
}

/** Lectura de un registro: se muestra con DetailCard. */
export interface SalidaDetalle {
  titulo: string;
  campos: { etiqueta: string; valor: string }[];
}

/** Serie para gráficos: se muestra con TrendChart. */
export interface SalidaSerie {
  titulo?: string;
  unidad?: string;
  tipo?: 'linea' | 'barras';
  x: string[];
  series: { id: string; etiqueta: string; valores: string[] }[];
}

/** Hallazgo de `detectar_anomalias`. */
export interface Anomalia {
  id: string;
  titulo: string;
  severidad: 'baja' | 'media' | 'alta';
  /** Por qué se la muestra: la regla y la línea base usadas. */
  por_que: string;
  observado: string;
  esperado: string;
  fecha?: string;
}
