import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './LlmProvider.js';

/** Precio en USD por millón de tokens. */
export interface PrecioModelo {
  entrada: number;
  salida: number;
}

/** Para un modelo sin precio conocido: deliberadamente alto, para que el tope de gasto proteja. */
export const PRECIO_DESCONOCIDO: PrecioModelo = { entrada: 5, salida: 25 };

export const LIMITE_USD_POR_DEFECTO = 5;

/**
 * Tabla de precios: es una ESTIMACIÓN que configura quien despliega (`LLM_PRECIOS_JSON` o la opción `precios`),
 * no una factura. Coincide por nombre exacto o por el prefijo más largo.
 */
export function precioDe(modelo: string, tabla: Readonly<Record<string, PrecioModelo>>): PrecioModelo {
  const exacto = tabla[modelo];
  if (exacto) return exacto;
  const k = Object.keys(tabla)
    .filter((c) => modelo.startsWith(c))
    .sort((a, b) => b.length - a.length)[0];
  return k ? (tabla[k] as PrecioModelo) : PRECIO_DESCONOCIDO;
}

/** True si el modelo tiene precio en la tabla (exacto o por prefijo); false si `precioDe` caería en `PRECIO_DESCONOCIDO`. */
export const tienePrecio = (modelo: string, tabla: Readonly<Record<string, PrecioModelo>>): boolean => modelo in tabla || Object.keys(tabla).some((c) => modelo.startsWith(c));

export const costoUsd = (p: PrecioModelo, entrada: number, salida: number): number => (entrada * p.entrada + salida * p.salida) / 1_000_000;

export function preciosDeEntorno(env: Record<string, string | undefined> = process.env): Record<string, PrecioModelo> {
  const crudo = env['LLM_PRECIOS_JSON'];
  if (!crudo) return {};
  try {
    const t = JSON.parse(crudo) as Record<string, PrecioModelo>;
    return Object.fromEntries(Object.entries(t).filter(([, p]) => typeof p?.entrada === 'number' && typeof p?.salida === 'number'));
  } catch {
    return {};
  }
}

interface ArchivoUso {
  limite_usd: number;
  total_usd: number;
  modelos: Record<string, { llamadas: number; tokens_entrada: number; tokens_salida: number; costo_usd: number }>;
}

export interface EstadoUso {
  total_usd: number;
  limite_usd: number;
  porcentaje: number;
  /** Desde el 90 % del tope. */
  en_aviso: boolean;
  agotado: boolean;
}

export interface OpcionesUso {
  /** Archivo JSON persistente. Sin archivo, el contador vive en memoria. */
  archivo?: string | undefined;
  limiteUsd?: number;
  precios?: Record<string, PrecioModelo>;
}

/** Contador de gasto con tope. Persiste de forma atómica si se le da un archivo. */
export class UsoLlm {
  readonly limiteUsd: number;
  readonly precios: Record<string, PrecioModelo>;
  private datos: ArchivoUso;

  constructor(private readonly opciones: OpcionesUso = {}) {
    this.limiteUsd = opciones.limiteUsd ?? (Number(process.env['LLM_LIMITE_USD']) || LIMITE_USD_POR_DEFECTO);
    this.precios = { ...preciosDeEntorno(), ...(opciones.precios ?? {}) };
    this.datos = this.cargar();
  }

  private cargar(): ArchivoUso {
    const vacio: ArchivoUso = { limite_usd: this.limiteUsd, total_usd: 0, modelos: {} };
    const archivo = this.opciones.archivo;
    if (!archivo || !existsSync(archivo)) return vacio;
    try {
      return { ...vacio, ...(JSON.parse(readFileSync(archivo, 'utf8')) as Partial<ArchivoUso>), limite_usd: this.limiteUsd };
    } catch {
      return vacio;
    }
  }

  estado(): EstadoUso {
    const total = this.datos.total_usd;
    return { total_usd: total, limite_usd: this.limiteUsd, porcentaje: (total / this.limiteUsd) * 100, en_aviso: total >= this.limiteUsd * 0.9, agotado: total >= this.limiteUsd };
  }

  /** Lanza PRESUPUESTO_AGOTADO si el tope ya se alcanzó. Se llama ANTES de cada petición. */
  verificar(): void {
    if (this.estado().agotado) throw new LlmError(`Presupuesto agotado (tope USD ${this.limiteUsd})`, undefined, 'PRESUPUESTO_AGOTADO');
  }

  registrar(modelo: string, tokensEntrada: number, tokensSalida: number): number {
    const costo = costoUsd(precioDe(modelo, this.precios), tokensEntrada, tokensSalida);
    const m = (this.datos.modelos[modelo] ??= { llamadas: 0, tokens_entrada: 0, tokens_salida: 0, costo_usd: 0 });
    m.llamadas++;
    m.tokens_entrada += tokensEntrada;
    m.tokens_salida += tokensSalida;
    m.costo_usd += costo;
    this.datos.total_usd += costo;
    this.guardar();
    return costo;
  }

  private guardar(): void {
    const archivo = this.opciones.archivo;
    if (!archivo) return;
    mkdirSync(dirname(archivo), { recursive: true });
    const tmp = `${archivo}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.datos, null, 2));
    renameSync(tmp, archivo);
  }
}

/** Envuelve cualquier proveedor con el tope de gasto: verifica antes y anota el uso después. */
export class ProveedorConPresupuesto implements LlmProvider {
  constructor(
    private readonly interno: LlmProvider,
    readonly uso: UsoLlm,
  ) {}

  get nombre(): string {
    return `${this.interno.nombre}+presupuesto`;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.uso.verificar();
    const r = await this.interno.generate(req);
    if (r.uso) this.uso.registrar(r.uso.modelo, r.uso.tokensEntrada, r.uso.tokensSalida);
    return r;
  }
}
