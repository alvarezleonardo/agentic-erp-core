import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llamada, preciosDeEntorno, ScriptedProvider, tienePrecio, ultimoResultadoDeLectura, type LlmProvider, type LlmRequest, type LlmResponse, type PasoGuion, type PrecioModelo } from '@agentic-erp/llm';
import { crearDespliegue, contextoDe } from '../examples/erp-sintetico/src/index.js';

export const DIR_EVALS = dirname(fileURLToPath(import.meta.url));

type Obj = Record<string, unknown>;

export type PasoDorado =
  | { router: string[] }
  | { llamar: string; args: Obj }
  | { final: 'render_ui'; component: string; data?: Obj; sin_fuente?: boolean }
  | { final: 'clarify'; pregunta: string; opciones_desde: string }
  | { final: 'report_error'; codigo: string; mensaje: string };

export interface Frase {
  id: string;
  texto: string;
  rol: string;
  esperado: { origen: 'reglas' | 'llm' | 'sin_clasificar'; plan: string[]; tools: string[]; componente: string; step_up?: boolean };
  guion: PasoDorado[];
}

export const cargarFrases = (): Frase[] => (JSON.parse(readFileSync(join(DIR_EVALS, 'frases.json'), 'utf8')) as { frases: Frase[] }).frases;

const fuenteDe = (req: Parameters<Extract<PasoGuion, Function>>[0]): string | undefined => {
  const r = ultimoResultadoDeLectura(req);
  return (r?.['proposal_id'] ?? r?.['source_id']) as string | undefined;
};

/** Traduce la trayectoria dorada a un guion para ScriptedProvider. */
export function guionDe(f: Frase): PasoGuion[] {
  return f.guion.map((p): PasoGuion => {
    if ('router' in p) return llamada('plan_intent', { dominios: p.router });
    if ('llamar' in p) return llamada(p.llamar, p.args);
    if (p.final === 'render_ui') {
      return (req) => {
        const fuente = p.sin_fuente ? undefined : fuenteDe(req);
        return llamada('render_ui', { component: p.component, ...(fuente ? { proposal_id: fuente } : {}), ...(p.data ? { data: p.data } : {}) });
      };
    }
    if (p.final === 'clarify') {
      return (req) => {
        const filas = (ultimoResultadoDeLectura(req)?.['filas'] ?? []) as Obj[];
        return llamada('clarify', { pregunta: p.pregunta, opciones: filas.map((x) => ({ id: x[p.opciones_desde] })).filter((o) => typeof o.id === 'string') });
      };
    }
    return llamada('report_error', { codigo: p.codigo, mensaje: p.mensaje });
  });
}

export interface ResultadoFrase {
  id: string;
  texto: string;
  ok: boolean;
  fallas: string[];
  origen: string;
  plan: string[];
  tools: string[];
  componente: string;
  llamadasAlModelo: number;
  /** Desglose independiente del criterio de `ok` (ver `Desglose`). */
  routerOk: boolean;
  planOk: boolean;
  toolsOk: boolean;
  componenteOk: boolean;
}

/**
 * Definición de cada columna del desglose (cada una cuenta frases, sobre el total):
 * - router: el ORIGEN de la clasificación coincide (reglas, llm o sin_clasificar).
 * - plan: la lista de dominios que arma el router coincide, en orden.
 * - tools: con el guion offline, las tools usadas coinciden exactamente; con un modelo real, las esperadas están entre las usadas.
 * - componente: el componente del último ui.render del slot main coincide.
 * El criterio de acierto total (`ok`) no cambia: además exige sobres válidos, step-up, y las garantías del guion offline.
 */
export interface Desglose {
  total: number;
  aciertos: number;
  router: number;
  plan: number;
  tools: number;
  componente: number;
}

export function desglosar(resultados: readonly ResultadoFrase[]): Desglose {
  const n = (f: (r: ResultadoFrase) => boolean): number => resultados.filter(f).length;
  return { total: resultados.length, aciertos: n((r) => r.ok), router: n((r) => r.routerOk), plan: n((r) => r.planOk), tools: n((r) => r.toolsOk), componente: n((r) => r.componenteOk) };
}

/** Uso del modelo en una corrida. `costoUsd` es null si algún modelo usado no tiene precio configurado. */
export interface UsoCorrida {
  llamadas: number;
  tokensEntrada: number;
  tokensSalida: number;
  costoUsd: number | null;
  sinPrecio: boolean;
}

/** Envuelve un proveedor y suma lo que informa cada respuesta (`uso`), solo de esta corrida. */
export class MedidorUso implements LlmProvider {
  llamadas = 0;
  tokensEntrada = 0;
  tokensSalida = 0;
  costoEstimado = 0;
  readonly modelos = new Set<string>();

  constructor(
    private readonly interno: LlmProvider,
    private readonly precios: Readonly<Record<string, PrecioModelo>> = preciosDeEntorno(),
  ) {}

  get nombre(): string {
    return this.interno.nombre;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const r = await this.interno.generate(req);
    this.llamadas++;
    if (r.uso) {
      this.tokensEntrada += r.uso.tokensEntrada;
      this.tokensSalida += r.uso.tokensSalida;
      this.costoEstimado += r.uso.costoUsd;
      this.modelos.add(r.uso.modelo);
    }
    return r;
  }

  resumen(): UsoCorrida {
    const sinPrecio = [...this.modelos].some((m) => !tienePrecio(m, this.precios));
    return { llamadas: this.llamadas, tokensEntrada: this.tokensEntrada, tokensSalida: this.tokensSalida, costoUsd: sinPrecio ? null : this.costoEstimado, sinPrecio };
  }
}

const igual = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Corre una frase contra el ejemplo completo (servidor MCP real en memoria, router, agentes, compositor, validador).
 * Con `llm` undefined usa el ScriptedProvider de la trayectoria dorada y exige coincidencia exacta; con un modelo real
 * compara plan y componente y exige que las tools esperadas estén entre las usadas.
 */
export async function correrFrase(f: Frase, llm?: LlmProvider): Promise<ResultadoFrase> {
  const guionado = llm ? undefined : new ScriptedProvider(guionDe(f));
  const proveedor = llm ?? guionado!;
  const d = await crearDespliegue({ llm: proveedor });
  const fallas: string[] = [];
  try {
    const sesion = d.orquestador.crearSesion(contextoDe(f.rol));
    const sobres = await sesion.texto(f.texto);
    const corrida = sesion.ultimaCorrida!;
    const tools = d.trace.porIntencion(corrida.intentId).filter((e) => e.evento === 'tool_llamada').map((e) => String(e['tool']));
    const principales = sobres.filter((s) => s['type'] === 'ui.render' && s['slot'] === 'main');
    const ultimo = principales[principales.length - 1];
    const componente = String(ultimo?.['component'] ?? 'ninguno');

    const planOk = igual(corrida.plan.plan, f.esperado.plan);
    const routerOk = corrida.plan.origen === f.esperado.origen;
    const toolsOk = guionado ? igual(tools, f.esperado.tools) : f.esperado.tools.every((t) => tools.includes(t));
    const componenteOk = componente === f.esperado.componente;
    if (!planOk) fallas.push(`plan: obtuvo [${corrida.plan.plan}] y se esperaba [${f.esperado.plan}]`);
    if (guionado && !routerOk) fallas.push(`origen del router: ${corrida.plan.origen} (esperado ${f.esperado.origen})`);
    if (!toolsOk) fallas.push(`tools: usó [${tools}] y se esperaba [${f.esperado.tools}]`);
    if (!componenteOk) fallas.push(`componente: ${componente} (esperado ${f.esperado.componente})`);
    for (const s of sobres) {
      const v = d.orquestador.validador.validarSobre(s);
      if (!v.ok) fallas.push(`sobre inválido (${String(s['component'] ?? s['type'])}): ${v.errores.join('; ')}`);
    }
    if (f.esperado.step_up !== undefined && ultimo) {
      const conf = ((ultimo['actions'] ?? []) as Obj[]).find((a) => a['id'] === 'confirmar');
      const tiene = conf?.['step_up'] !== undefined && conf['step_up'] !== 'none';
      if (tiene !== f.esperado.step_up) fallas.push(`step-up: ${tiene ? 'pide' : 'no pide'} autorización y se esperaba ${f.esperado.step_up ? 'que pidiera' : 'que no pidiera'}`);
    }
    if (guionado) {
      const vistas = guionado.entradasSerializadas();
      for (const t of sesion.store.tokensGuardados()) if (vistas.includes(t)) fallas.push('un token de confirmación llegó al modelo');
      if (guionado.pendientes !== 0) fallas.push(`quedaron ${guionado.pendientes} pasos del guion sin usar`);
    }
    return { id: f.id, texto: f.texto, ok: fallas.length === 0, fallas, origen: corrida.plan.origen, plan: corrida.plan.plan, tools, componente, llamadasAlModelo: guionado?.llamadas.length ?? 0, routerOk, planOk, toolsOk, componenteOk };
  } catch (e) {
    fallas.push(`excepción: ${e instanceof Error ? e.message : String(e)}`);
    return { id: f.id, texto: f.texto, ok: false, fallas, origen: '-', plan: [], tools: [], componente: '-', llamadasAlModelo: 0, routerOk: false, planOk: false, toolsOk: false, componenteOk: false };
  } finally {
    await d.cerrar();
  }
}

export interface MetaReporte {
  proveedor: string;
  /** Modelo usado; con el guion offline es el nombre del proveedor. */
  modelo?: string;
  fecha: string;
  uso?: UsoCorrida;
}

const nf = new Intl.NumberFormat('en-US');
const usd = (v: number): string => (v === 0 ? 'USD 0' : `USD ${v.toFixed(v < 0.01 ? 6 : 4)}`);

/** Texto del costo: "sin precio" si el modelo no tiene tarifa configurada, nunca un valor inventado. */
export const textoCosto = (u?: UsoCorrida): string => (!u ? 'USD 0' : u.sinPrecio ? 'sin precio' : usd(u.costoUsd ?? 0));

const AREAS: Record<string, string> = { ven: 'Ventas', sto: 'Stock', com: 'Compras', caj: 'Caja', cruz: 'Varias áreas', sin: 'Sin clasificar' };

export function generarReporte(resultados: readonly ResultadoFrase[], meta: MetaReporte): string {
  const aciertos = resultados.filter((r) => r.ok).length;
  const d = desglosar(resultados);
  const pct = resultados.length ? ((aciertos / resultados.length) * 100).toFixed(1) : '0.0';
  const lineas: string[] = [
    '# Reporte de evals: ERP sintético',
    '',
    `- Proveedor: ${meta.proveedor}`,
    `- Modelo: ${meta.modelo ?? meta.proveedor}`,
    `- Fecha: ${meta.fecha}`,
    `- Frases: ${resultados.length}`,
    `- Aciertos: ${aciertos} (${pct} %)`,
    `- Router (origen coincide): ${d.router}/${d.total}`,
    `- Plan (dominios coinciden): ${d.plan}/${d.total}`,
    `- Tools correctas: ${d.tools}/${d.total}`,
    `- Componente correcto: ${d.componente}/${d.total}`,
    `- Costo de la corrida: ${textoCosto(meta.uso)}`,
    `- Tokens: ${nf.format(meta.uso?.tokensEntrada ?? 0)} de entrada, ${nf.format(meta.uso?.tokensSalida ?? 0)} de salida`,
    `- Por reglas: ${resultados.filter((r) => r.origen === 'reglas').length}, por modelo: ${resultados.filter((r) => r.origen === 'llm').length}, sin clasificar: ${resultados.filter((r) => r.origen === 'sin_clasificar').length}`,
    '',
    '## Por área',
    '',
    '| Área | Frases | Aciertos |',
    '|---|---|---|',
  ];
  for (const [prefijo, nombre] of Object.entries(AREAS)) {
    const rs = resultados.filter((r) => r.id.startsWith(`${prefijo}-`));
    if (rs.length) lineas.push(`| ${nombre} | ${rs.length} | ${rs.filter((r) => r.ok).length} |`);
  }
  lineas.push('', '## Detalle', '', '| Id | Frase | Plan | Tools | Componente | Resultado |', '|---|---|---|---|---|---|');
  for (const r of resultados) lineas.push(`| ${r.id} | ${r.texto} | ${r.plan.join(' + ') || '-'} | ${r.tools.join(', ') || '-'} | ${r.componente} | ${r.ok ? 'ok' : 'FALLA'} |`);
  const malas = resultados.filter((r) => !r.ok);
  if (malas.length) {
    lineas.push('', '## Fallas', '');
    for (const r of malas) lineas.push(`- **${r.id}** «${r.texto}»`, ...r.fallas.map((x) => `  - ${x}`));
  }
  return `${lineas.join('\n')}\n`;
}
