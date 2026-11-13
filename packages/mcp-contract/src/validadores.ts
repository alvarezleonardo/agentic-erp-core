import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModulo from 'ajv-formats';
import type { Obj } from './tipos.js';

const addFormats = (addFormatsModulo as unknown as { default: (a: Ajv2020) => void }).default;

const RUTA_SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), '../schema/contract.schema.json');

/** Nombres de las definiciones del contrato (`$defs`). */
export type NombreContrato =
  | 'Dinero'
  | 'Contexto'
  | 'ErrorTool'
  | 'Propuesta'
  | 'ConfirmarEntrada'
  | 'ConfirmarSalida'
  | 'Evento'
  | 'ConsumirEventosEntrada'
  | 'ConsumirEventosSalida'
  | 'DefMetrica'
  | 'ListarMetricasSalida'
  | 'ConsultarMetricaEntrada'
  | 'SalidaMetricas'
  | 'SalidaTabla'
  | 'SalidaDetalle'
  | 'SalidaSerie'
  | 'Anomalia'
  | 'DetectarAnomaliasSalida';

let ajv: Ajv2020 | undefined;
const cache = new Map<string, ValidateFunction>();

/** El JSON Schema del contrato, para quien quiera validar desde otro lenguaje. */
export function schemaDelContrato(): Obj {
  return JSON.parse(readFileSync(RUTA_SCHEMA, 'utf8')) as Obj;
}

function validador(nombre: NombreContrato): ValidateFunction {
  const hit = cache.get(nombre);
  if (hit) return hit;
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(schemaDelContrato());
  }
  const fn = ajv.getSchema(`https://agentic-erp.dev/contract/v0/contract.schema.json#/$defs/${nombre}`);
  if (!fn) throw new Error(`definición de contrato desconocida: ${nombre}`);
  cache.set(nombre, fn);
  return fn;
}

export interface ResultadoContrato {
  ok: boolean;
  errores: string[];
}

/** Valida un valor contra una definición del contrato. */
export function validarContrato(nombre: NombreContrato, valor: unknown): ResultadoContrato {
  const fn = validador(nombre);
  const ok = fn(valor) as boolean;
  return { ok, errores: ok ? [] : (fn.errors ?? []).map((e) => `${e.instancePath || '(raiz)'} ${e.message ?? 'inválido'}`) };
}
