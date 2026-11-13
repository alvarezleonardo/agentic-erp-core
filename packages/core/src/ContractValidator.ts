import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModulo from 'ajv-formats';
import type { Obj } from './util.js';

// ajv-formats es CommonJS: con NodeNext el export por defecto llega envuelto en `.default`.
const addFormats = (addFormatsModulo as unknown as { default: (a: Ajv2020) => void }).default;

/**
 * Carpeta contracts/genui del checkout de desarrollo, resuelta desde este archivo. Es solo un FALLBACK para
 * trabajar dentro del monorepo: en un paquete publicado esa ruta relativa no existe, así que quien consume
 * `@agentic-erp/core` debe pasar el directorio a `new ContractValidator(dir)` (o definir CONTRACTS_DIR).
 */
export const DIR_GENUI = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/genui');

export interface ResultadoValidacion {
  ok: boolean;
  errores: string[];
}

export interface InfoComponente {
  nombre: string;
  version: number;
  schema: Obj;
}

const formatear = (errs: ErrorObject[] | null | undefined): string[] =>
  (errs ?? []).map((e) => `${e.instancePath || '(raiz)'} ${e.message ?? 'inválido'}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params['additionalProperty'])})` : ''}`);

/** Valida sobres, mensajes de la superficie y la `data` de cada componente contra los JSON Schema versionados de contracts/genui. */
export class ContractValidator {
  private readonly ajv: Ajv2020;
  private readonly envelope: ValidateFunction;
  private readonly cliente: ValidateFunction;
  private readonly componentes = new Map<string, InfoComponente>();

  /**
   * @param dir Directorio con los JSON Schema de GenUI (`envelope.schema.json`, `client-message.schema.json` y
   *   `components/*.schema.json`). Orden de resolución: este parámetro, la variable de entorno CONTRACTS_DIR y,
   *   por último, `DIR_GENUI` (solo válido en desarrollo dentro del monorepo).
   */
  constructor(dir: string = process.env['CONTRACTS_DIR'] ?? DIR_GENUI) {
    if (!existsSync(join(dir, 'envelope.schema.json'))) {
      throw new Error(`No se encontraron los schemas de GenUI en ${dir}. Pasá el directorio a new ContractValidator(dir) o definí CONTRACTS_DIR.`);
    }
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);
    for (const k of ['x-source', 'x-editable', 'x-hidden']) this.ajv.addKeyword({ keyword: k });

    const leer = (ruta: string): Obj => JSON.parse(readFileSync(ruta, 'utf8')) as Obj;
    const env = leer(join(dir, 'envelope.schema.json'));
    const cli = leer(join(dir, 'client-message.schema.json'));
    this.ajv.addSchema(env);
    this.ajv.addSchema(cli);
    this.envelope = this.ajv.getSchema(env['$id'] as string) as ValidateFunction;
    this.cliente = this.ajv.getSchema(cli['$id'] as string) as ValidateFunction;

    const dirComp = join(dir, 'components');
    for (const archivo of readdirSync(dirComp).filter((f) => f.endsWith('.schema.json'))) {
      const m = /^([A-Z][A-Za-z0-9]+)\.v(\d+)\.schema\.json$/.exec(archivo);
      if (!m) continue;
      const schema = leer(join(dirComp, archivo));
      this.ajv.addSchema(schema);
      this.componentes.set(`${m[1]}@${m[2]}`, { nombre: m[1] as string, version: Number(m[2]), schema });
    }
  }

  componente(nombre: string, version: number): InfoComponente | undefined {
    return this.componentes.get(`${nombre}@${version}`);
  }

  /** Versiones disponibles de un componente, de mayor a menor. */
  versiones(nombre: string): number[] {
    return [...this.componentes.values()]
      .filter((c) => c.nombre === nombre)
      .map((c) => c.version)
      .sort((a, b) => b - a);
  }

  nombresComponentes(): string[] {
    return [...new Set([...this.componentes.values()].map((c) => c.nombre))].sort();
  }

  validarDatos(nombre: string, version: number, data: unknown): ResultadoValidacion {
    const info = this.componente(nombre, version);
    if (!info) return { ok: false, errores: [`componente desconocido: ${nombre} v${version}`] };
    const fn = this.ajv.getSchema(info.schema['$id'] as string);
    if (!fn) return { ok: false, errores: [`schema no compilado: ${nombre}`] };
    const ok = fn(data) as boolean;
    return { ok, errores: ok ? [] : formatear(fn.errors).map((e) => `data${e}`) };
  }

  /** Valida el sobre completo y, si trae componente, su data. */
  validarSobre(sobre: unknown): ResultadoValidacion {
    const errores: string[] = [];
    if (!(this.envelope(sobre) as boolean)) errores.push(...formatear(this.envelope.errors).map((e) => `sobre${e}`));
    const s = sobre as Obj;
    if (typeof s?.['component'] === 'string' && typeof s['component_version'] === 'number') {
      errores.push(...this.validarDatos(s['component'], s['component_version'], s['data']).errores);
    }
    return { ok: errores.length === 0, errores };
  }

  validarMensajeCliente(msg: unknown): ResultadoValidacion {
    const ok = this.cliente(msg) as boolean;
    return { ok, errores: ok ? [] : formatear(this.cliente.errors).map((e) => `mensaje${e}`) };
  }
}
