# Auditoría: trazas reales

Cada intención deja una traza JSONL (`Trace`, ver [`packages/core/src/trace.ts`](../../packages/core/src/trace.ts)): una línea por evento, con los secretos redactados. Acá hay tres corridas completas con el ERP sintético (v0.1.1, 24/11/2026), con el modelo guionado y sin editar ningún valor. Los `ts` y los ids son aleatorios y cambian en cada corrida.

Para reproducirlas: `npm run ejemplo:auditoria` (código en [`examples/erp-sintetico/src/auditoria.ts`](../../examples/erp-sintetico/src/auditoria.ts)). La política es la de la demo: los egresos desde 50,00 piden la confirmación de un supervisor. La frase en los tres casos es `registrá un egreso de caja de 85 por limpieza`.

## 1. Camino feliz

El modelo propone el egreso, el servidor arma la tarjeta, supervisor1 confirma y se escribe un movimiento en el ERP.

```jsonl
{"ts":"2026-11-24T12:37:22.393Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"intencion_inicio","texto":"registrá un egreso de caja de 85 por limpieza","rol":"operador"}
{"ts":"2026-11-24T12:37:22.393Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"router","plan":["caja"],"origen":"reglas"}
{"ts":"2026-11-24T12:37:22.394Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"agente_inicio","agente":"caja","tools":5}
{"ts":"2026-11-24T12:37:22.394Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"llm_respuesta","agente":"caja","paso":1,"llamadas":["preparar_movimiento_caja"],"texto":false}
{"ts":"2026-11-24T12:37:22.394Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"tool_llamada","agente":"caja","tool":"preparar_movimiento_caja","args":{"tipo":"egreso","concepto":"Limpieza","importe":"85"}}
{"ts":"2026-11-24T12:37:22.395Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"propuesta_guardada","agente":"caja","tool":"preparar_movimiento_caja","proposal_id":"prop_0001"}
{"ts":"2026-11-24T12:37:22.395Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"llm_respuesta","agente":"caja","paso":2,"llamadas":["render_ui"],"texto":false}
{"ts":"2026-11-24T12:37:22.398Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"directiva_final","agente":"caja","directiva":"render_ui","componente":"ConfirmationCard","fuente":"prop_0001","valida":true}
{"ts":"2026-11-24T12:37:22.399Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"confirmacion_enviada","proposal_id":"prop_0001","tool":"confirmar_movimiento_caja","step_up":"supervisor","con_autorizacion":true}
{"ts":"2026-11-24T12:37:22.424Z","trace_id":"tr_171c0e75","intent_id":"int_232xg64vvaw7","evento":"confirmacion_aplicada","proposal_id":"prop_0001","tool":"confirmar_movimiento_caja","idempotente":false}
```

Qué se lee en la traza:

- `tool_llamada`: los `args` que mandó el modelo son `tipo`, `concepto` e `importe` como los dijo la persona. El total que ve el supervisor lo calcula el servidor; no está en lo que pidió el modelo.
- `directiva_final` con `fuente: "prop_0001"` y `valida: true`: la tarjeta se renderizó a partir de la propuesta guardada, no de lo que escribió el modelo.
- `confirmacion_enviada` con `step_up: "supervisor"` y `con_autorizacion: true`: la confirmación llegó con credencial de supervisor, que no figura en la traza.
- `confirmacion_aplicada` con `idempotente: false`: es la primera escritura. Movimientos nuevos en el ERP: 1.

## 2. Autorización inválida

Misma propuesta, pero el supervisor confirma con una autorización inválida. El servidor rechaza, no se escribe nada.

```jsonl
{"ts":"2026-11-24T12:37:22.472Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"intencion_inicio","texto":"registrá un egreso de caja de 85 por limpieza","rol":"operador"}
{"ts":"2026-11-24T12:37:22.472Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"router","plan":["caja"],"origen":"reglas"}
{"ts":"2026-11-24T12:37:22.472Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"agente_inicio","agente":"caja","tools":5}
{"ts":"2026-11-24T12:37:22.472Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"llm_respuesta","agente":"caja","paso":1,"llamadas":["preparar_movimiento_caja"],"texto":false}
{"ts":"2026-11-24T12:37:22.472Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"tool_llamada","agente":"caja","tool":"preparar_movimiento_caja","args":{"tipo":"egreso","concepto":"Limpieza","importe":"85"}}
{"ts":"2026-11-24T12:37:22.472Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"propuesta_guardada","agente":"caja","tool":"preparar_movimiento_caja","proposal_id":"prop_0001"}
{"ts":"2026-11-24T12:37:22.472Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"llm_respuesta","agente":"caja","paso":2,"llamadas":["render_ui"],"texto":false}
{"ts":"2026-11-24T12:37:22.473Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"directiva_final","agente":"caja","directiva":"render_ui","componente":"ConfirmationCard","fuente":"prop_0001","valida":true}
{"ts":"2026-11-24T12:37:22.473Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"confirmacion_enviada","proposal_id":"prop_0001","tool":"confirmar_movimiento_caja","step_up":"supervisor","con_autorizacion":true}
{"ts":"2026-11-24T12:37:22.498Z","trace_id":"tr_8286cb0b","intent_id":"int_h1bw0j56v16y","evento":"confirmacion_rechazada","proposal_id":"prop_0001","codigo":"AUTORIZACION_INVALIDA","origen":"servidor"}
```

Qué se lee en la traza:

- Los primeros 9 eventos son idénticos al caso feliz: hasta la tarjeta no hay diferencia.
- `confirmacion_rechazada` con `codigo: "AUTORIZACION_INVALIDA"` y `origen: "servidor"`: el rechazo lo decide el servidor MCP, no el orquestador. No hay `confirmacion_aplicada`.
- Movimientos nuevos en el ERP: 0. La persona ve un aviso ("Usuario o credencial de autorización incorrectos.").

## 3. Reintento con la misma `idempotency_key`

Se confirma bien y se envía de nuevo exactamente la misma confirmación (mismo token, misma clave de idempotencia).

```jsonl
{"ts":"2026-11-24T12:37:22.539Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"intencion_inicio","texto":"registrá un egreso de caja de 85 por limpieza","rol":"operador"}
{"ts":"2026-11-24T12:37:22.539Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"router","plan":["caja"],"origen":"reglas"}
{"ts":"2026-11-24T12:37:22.539Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"agente_inicio","agente":"caja","tools":5}
{"ts":"2026-11-24T12:37:22.539Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"llm_respuesta","agente":"caja","paso":1,"llamadas":["preparar_movimiento_caja"],"texto":false}
{"ts":"2026-11-24T12:37:22.539Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"tool_llamada","agente":"caja","tool":"preparar_movimiento_caja","args":{"tipo":"egreso","concepto":"Limpieza","importe":"85"}}
{"ts":"2026-11-24T12:37:22.539Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"propuesta_guardada","agente":"caja","tool":"preparar_movimiento_caja","proposal_id":"prop_0001"}
{"ts":"2026-11-24T12:37:22.539Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"llm_respuesta","agente":"caja","paso":2,"llamadas":["render_ui"],"texto":false}
{"ts":"2026-11-24T12:37:22.540Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"directiva_final","agente":"caja","directiva":"render_ui","componente":"ConfirmationCard","fuente":"prop_0001","valida":true}
{"ts":"2026-11-24T12:37:22.540Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"confirmacion_enviada","proposal_id":"prop_0001","tool":"confirmar_movimiento_caja","step_up":"supervisor","con_autorizacion":true}
{"ts":"2026-11-24T12:37:22.564Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"confirmacion_aplicada","proposal_id":"prop_0001","tool":"confirmar_movimiento_caja","idempotente":false}
{"ts":"2026-11-24T12:37:22.564Z","trace_id":"tr_26138be4","intent_id":"int_z5p1pr1h4n0h","evento":"confirmacion_idempotente","proposal_id":"prop_0001"}
```

Qué se lee en la traza:

- Hay un solo `confirmacion_enviada` y un solo `confirmacion_aplicada` (con `idempotente: false`): el reintento no registra un segundo envío al servidor.
- `confirmacion_idempotente` para `prop_0001`: el segundo envío se reconoció como repetido y devolvió el resultado anterior.
- Movimientos nuevos en el ERP: 1, no 2. La persona ve el mismo toast de éxito las dos veces.

## Qué no está en la traza

En las tres corridas se verificó con código (no a ojo) que ni el `confirmation_token` ni la autorización del supervisor aparecen en la traza completa. La credencial enviada se busca como valor JSON entre comillas, porque los ids aleatorios podrían contener esos mismos dígitos por casualidad. En la corrida de la autorización inválida se buscó la credencial que se envió. Resultado: `sinSecretos: true` en las tres.

Vuelta al [README](../../README.md#auditoría).
