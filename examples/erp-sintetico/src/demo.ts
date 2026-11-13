import { llamada, ScriptedProvider, ultimoResultadoDeLectura, type PasoGuion } from '@agentic-erp/llm';
import { fileURLToPath } from 'node:url';
import { crearDespliegue, contextoDe, PIN_SUPERVISOR_DE_PRUEBA } from './index.js';

type Obj = Record<string, unknown>;

export interface Garantia {
  texto: string;
  ok: boolean;
}

export interface SalidaDemo {
  /** Monto de la tarjeta, tal como lo puso el servidor MCP. */
  montoTarjeta: { monto: string; moneda: string };
  stepUp: string | undefined;
  /** Toast final tras confirmar. */
  resultado: Obj | undefined;
  /** Movimientos de caja con ese concepto ya registrados en el ERP. */
  registrados: number;
  /** Movimientos totales del ERP antes de proponer, tras proponer y tras confirmar. */
  movimientos: { inicio: number; trasPropuesta: number; final: number };
  /** Garantías verificadas en runtime (no texto fijo). */
  garantias: Garantia[];
  /** true si todas las garantías se cumplieron. */
  ok: boolean;
}

export interface OpcionesDemo {
  escribir?: (linea: string) => void;
  pausaMs?: number;
  pin?: string;
  /** Colores ANSI. Por defecto apagado (la terminal real lo enciende en el main). */
  color?: boolean;
}

const FRASE = 'registrá un egreso de caja de 85 por limpieza';
const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const enmascarar = (pin: string): string => '*'.repeat(pin.length);
const plural = (n: number, sufijo = ''): string => `${n} ${n === 1 ? 'movimiento' : 'movimientos'}${sufijo && n !== 1 ? `${sufijo}s` : sufijo}`;

/** Formato de la demo con la moneda que informa el servidor: `USD 12.450,75`. */
export const formatoMonto = (monto: string, moneda: string): string => {
  const [ent = '0', dec = '00'] = monto.split('.');
  return `${moneda} ${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
};

/** Largo visible de una línea (sin secuencias ANSI). */
const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/**
 * Flujo completo sin red ni claves: frase -> tarjeta con el monto puesto por el servidor MCP -> PIN del supervisor
 * (step-up) -> escritura confirmada. El LLM es un ScriptedProvider: solo "dice" el tool y el componente; el importe
 * que se muestra viene del servidor. Cada garantía del cierre se verifica en runtime contra lo que pasó de verdad.
 */
export async function correrDemo(o: OpcionesDemo = {}): Promise<SalidaDemo> {
  const out = o.escribir ?? ((l: string) => console.log(l));
  const pausa = o.pausaMs ?? 0;
  const pin = o.pin ?? PIN_SUPERVISOR_DE_PRUEBA;
  const c = (codigo: string) => (t: string): string => (o.color ? `\x1b[${codigo}m${t}\x1b[0m` : t);
  const negrita = c('1');
  const tenue = c('2');
  const verde = c('32');
  const rojo = c('1;31');
  const cian = c('36');
  const amarillo = c('33');
  const paso = async (n: number, titulo: string): Promise<void> => {
    out('');
    out(negrita(cian(`[${n}/4] ${titulo}`)));
    if (pausa) await dormir(pausa);
  };

  const final: PasoGuion = (req) => {
    const r = ultimoResultadoDeLectura(req);
    return llamada('render_ui', { component: 'ConfirmationCard', proposal_id: r?.['proposal_id'] });
  };
  const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Limpieza', importe: '85' }), final]);
  // Registro de lo que el modelo pidió (tool calls) para poder auditarlo al final.
  const llamadasDelModelo: { name: string; args: Obj }[] = [];
  const generarOriginal = llm.generate.bind(llm);
  llm.generate = async (req) => {
    const r = await generarOriginal(req);
    for (const tc of r.toolCalls ?? []) llamadasDelModelo.push({ name: tc.name, args: tc.args as Obj });
    return r;
  };
  // Política de la demo: los egresos desde 50.00 piden un supervisor (en el ERP sintético el umbral por defecto es 500.00).
  const d = await crearDespliegue({ llm, erp: { umbralesCaja: { supervisor: 5_000 } } });
  try {
    const sesion = d.orquestador.crearSesion(contextoDe('operador'));
    const inicio = d.erp.datos.movimientos.length;

    out(negrita('El modelo propone, el servidor pone el monto, la persona confirma con PIN.'));
    out(tenue('Mirá: quién pone el monto, por dónde viaja el PIN, cuándo se escribe.'));
    out(`ERP al empezar: ${amarillo(plural(inicio))} de caja (se cuentan los nuevos)`);
    if (pausa) await dormir(pausa);

    await paso(1, 'La persona escribe');
    out(`  > ${FRASE}`);
    const sobres = await sesion.texto(FRASE);

    await paso(2, 'El MODELO propone, el SERVIDOR arma la tarjeta');
    const tarjeta = sobres.find((s) => s['component'] === 'ConfirmationCard');
    if (!tarjeta) throw new Error('No se devolvió una ConfirmationCard');
    const data = tarjeta['data'] as Obj;
    const total = data['total'] as { monto: string; moneda: string };
    const stepUp = data['step_up'] as string | undefined;
    const pedido = llamadasDelModelo.find((l) => l.name.startsWith('preparar_'));
    const args = Object.entries(pedido?.args ?? {})
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    out(`  ${negrita('MODELO  ')} llamó ${pedido?.name ?? '(ninguna preparar_*)'}`);
    out(`           ${args}`);
    out(`  ${negrita('SERVIDOR')} devolvió ConfirmationCard: ${String(data['titulo'])}`);
    out(`           monto ${negrita(formatoMonto(total.monto, total.moneda))} (calculado por el servidor)`);
    out(`           pide PIN: ${stepUp && stepUp !== 'none' ? `sí, ${stepUp}` : 'no'}`);
    const trasPropuesta = d.erp.datos.movimientos.length;
    out(`  ERP: ${amarillo(plural(trasPropuesta - inicio, ' nuevo'))}, todavía no se escribió nada`);

    await paso(3, 'El supervisor confirma con su PIN');
    out(`  supervisor1  PIN ${enmascarar(pin)}   pantalla -> servidor`);
    out(tenue('  (el modelo no está en este camino)'));
    const accion = (tarjeta['actions'] as Obj[]).find((a) => a['id'] === 'confirmar');
    const respuesta = await sesion.manejar({
      v: '1.1',
      type: 'ui.action',
      message_id: 'demo_m1',
      intent_id: tarjeta['intent_id'],
      action_id: accion?.['id'] ?? 'confirmar',
      proposal_id: data['proposal_id'],
      confirmation: { confirmation_token: data['confirmation_token'], idempotency_key: 'demo_idk_0001', step_up: { usuario: 'supervisor1', pin } },
    });

    await paso(4, 'Escritura en el ERP');
    const toast = (respuesta as Obj[]).find((s) => s['component'] === 'StatusToast');
    const td = (toast?.['data'] ?? {}) as Obj;
    const movs = d.erp.datos.movimientos.filter((m) => m.concepto === 'Limpieza');
    const finalMovs = d.erp.datos.movimientos.length;
    out(`  StatusToast (${String(td['nivel'] ?? '-')}): ${String(td['mensaje'] ?? '-')}`);
    out(`  ERP: ${verde(plural(finalMovs - inicio, ' nuevo'))}`);
    if (pausa) await dormir(pausa);

    // --- Garantías: cada una sale de una comprobación real, no de texto fijo. ---
    const visto = llm.entradasSerializadas();
    const token = String(data['confirmation_token']);
    const propuesta = ultimaPropuesta(llm);
    const renderArgs = llamadasDelModelo.find((l) => l.name === 'render_ui')?.args ?? {};
    const garantias: Garantia[] = [
      {
        texto: 'El modelo no escribió nada: ninguna confirmar_*, 0 movimientos antes del PIN',
        ok: !llamadasDelModelo.some((l) => l.name.startsWith('confirmar_')) && trasPropuesta === inicio,
      },
      {
        texto: 'El monto lo puso el servidor: la tarjeta repite su propuesta',
        ok: !!propuesta && propuesta.monto === total.monto && propuesta.moneda === total.moneda && !('total' in renderArgs) && !('monto' in renderArgs),
      },
      {
        texto: 'El modelo nunca vio el token ni el PIN',
        ok: token.length > 16 && !visto.includes(token) && !visto.includes(pin),
      },
      {
        texto: 'Se escribió solo después de confirmar: 1 movimiento, tras el PIN',
        ok: finalMovs === inicio + 1 && movs.length === 1 && td['nivel'] !== 'error',
      },
    ];
    const lineas = garantias.map((g) => `${g.ok ? verde('[ok]') : rojo('[FALLA]')} ${g.texto}`);
    const ancho = Math.max(...lineas.map(visible), 60) + 2;
    const borde = (t: string): string => `+${t}${'-'.repeat(ancho - visible(t))}+`;
    out('');
    out(borde('- Garantías verificadas en esta corrida '));
    for (const l of lineas) out(`| ${l}${' '.repeat(ancho - visible(l) - 1)}|`);
    out(borde(''));

    const todoOk = garantias.every((g) => g.ok);
    if (!todoOk) out(rojo('[FALLA] al menos una garantía no se cumplió.'));
    return { montoTarjeta: total, stepUp, resultado: toast, registrados: movs.length, movimientos: { inicio, trasPropuesta, final: finalMovs }, garantias, ok: todoOk };
  } finally {
    await d.cerrar();
  }
}

/** Total de la propuesta tal como el servidor se la devolvió al modelo en el resultado de `preparar_*`. */
function ultimaPropuesta(llm: ScriptedProvider): { monto: string; moneda: string } | undefined {
  for (const req of [...llm.llamadas].reverse()) {
    for (const m of [...req.messages].reverse()) {
      if (m.role !== 'tool') continue;
      const r = m.results.find((x) => x.name.startsWith('preparar_'));
      const t = (r?.result as Obj | undefined)?.['total'] as { monto: string; moneda: string } | undefined;
      if (t) return t;
    }
  }
  return undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const salida = await correrDemo({
    pausaMs: Number(process.env['DEMO_PAUSA_MS'] ?? 0),
    color: Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'],
    ...(process.env['DEMO_PIN'] ? { pin: process.env['DEMO_PIN'] } : {}),
  });
  if (!salida.ok) process.exitCode = 1;
}
