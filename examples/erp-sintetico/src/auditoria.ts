import { llamada, ScriptedProvider, ultimoResultadoDeLectura, type PasoGuion } from '@agentic-erp/llm';
import { fileURLToPath } from 'node:url';
import { crearDespliegue, contextoDe, PIN_SUPERVISOR_DE_PRUEBA } from './index.js';

type Obj = Record<string, unknown>;

export type Escenario = 'feliz' | 'autorizacion_invalida' | 'reintento';

export interface SalidaAuditoria {
  escenario: Escenario;
  /** Traza completa (JSONL) de la corrida, tal como la serializa `Trace`. */
  jsonl: string;
  /** Movimientos de caja nuevos en el ERP al terminar. */
  movimientosNuevos: number;
  /** Respuestas de la confirmación (una por intento). */
  respuestas: Obj[][];
  /** true si ni el token ni la autorización del supervisor aparecen en la traza (la credencial se busca como valor JSON). */
  sinSecretos: boolean;
}

const FRASE = 'registrá un egreso de caja de 85 por limpieza';

/** Corre un escenario de auditoría con un despliegue nuevo y devuelve la traza real. */
export async function correrAuditoria(escenario: Escenario): Promise<SalidaAuditoria> {
  const final: PasoGuion = (req) => {
    const r = ultimoResultadoDeLectura(req);
    return llamada('render_ui', { component: 'ConfirmationCard', proposal_id: r?.['proposal_id'] });
  };
  const llm = new ScriptedProvider([llamada('preparar_movimiento_caja', { tipo: 'egreso', concepto: 'Limpieza', importe: '85' }), final]);
  const d = await crearDespliegue({ llm, erp: { umbralesCaja: { supervisor: 5_000 } } });
  try {
    const sesion = d.orquestador.crearSesion(contextoDe('operador'));
    const inicio = d.erp.datos.movimientos.length;
    const sobres = await sesion.texto(FRASE);
    const tarjeta = sobres.find((s) => s['component'] === 'ConfirmationCard');
    if (!tarjeta) throw new Error('No se devolvió una ConfirmationCard');
    const data = tarjeta['data'] as Obj;
    const token = String(data['confirmation_token']);
    const pin = escenario === 'autorizacion_invalida' ? '0000' : PIN_SUPERVISOR_DE_PRUEBA;
    const confirmar = (messageId: string): Promise<Obj[]> =>
      sesion.manejar({
        v: '1.1',
        type: 'ui.action',
        message_id: messageId,
        intent_id: tarjeta['intent_id'],
        action_id: 'confirmar',
        proposal_id: data['proposal_id'],
        confirmation: { confirmation_token: data['confirmation_token'], idempotency_key: 'aud_idk_0001', step_up: { usuario: 'supervisor1', pin } },
      }) as Promise<Obj[]>;
    const respuestas: Obj[][] = [await confirmar('aud_m1')];
    if (escenario === 'reintento') respuestas.push(await confirmar('aud_m2'));
    const jsonl = d.trace.serializado();
    return {
      escenario,
      jsonl,
      movimientosNuevos: d.erp.datos.movimientos.length - inicio,
      respuestas,
      sinSecretos: !jsonl.includes(token) && !jsonl.includes(JSON.stringify(pin)),
    };
  } finally {
    await d.cerrar();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const e of ['feliz', 'autorizacion_invalida', 'reintento'] as const) {
    const s = await correrAuditoria(e);
    console.log(`# ${e}: movimientos nuevos=${s.movimientosNuevos}, sin secretos=${s.sinSecretos}`);
    console.log(s.jsonl);
    console.log(`# respuestas: ${JSON.stringify(s.respuestas.map((r) => r.map((x) => [x['component'], (x['data'] as Obj | undefined)?.['nivel'], (x['data'] as Obj | undefined)?.['mensaje']])))}`);
    console.log('');
  }
}
