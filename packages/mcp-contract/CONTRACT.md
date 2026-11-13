# Contrato MCP para ERP

Este documento define lo que un servidor MCP de un ERP tiene que publicar para que `agentic-erp-core` pueda ponerle una capa agéntica encima. Los tipos están en `src/tipos.ts`, el JSON Schema en `schema/contract.schema.json` y la verificación automática en `verificarConformidad(tools)`.

La idea de fondo: **el agente propone y la persona decide**. El servidor es la autoridad sobre los montos, los permisos y los efectos. El orquestador nunca escribe en el ERP por su cuenta.

## 1. Reglas generales

1. Toda tool recibe `contexto` (objeto requerido) con `{ tenant, usuario, rol, sucursal?, origen? }`. Lo inyecta el orquestador; el modelo no lo ve ni lo fija. El servidor **debe** volver a verificar permisos con ese `contexto`.
2. Los campos reservados son `contexto`, `idempotency_key` e `id_intencion`. Se ocultan del esquema que ve el modelo.
3. Éxito: un objeto JSON (en `structuredContent` o como texto JSON). Error: respuesta MCP con `isError: true` y un objeto `{ codigo, mensaje, accion_sugerida? }`. Los códigos con significado fijo son: `PERMISO_DENEGADO`, `PROPUESTA_NO_ENCONTRADA`, `PROPUESTA_EXPIRADA`, `PROPUESTA_YA_CONFIRMADA`, `TOKEN_INVALIDO`, `STEP_UP_REQUERIDO`, `AUTORIZACION_INVALIDA`, `PARAMETRO_INVALIDO`, `NO_ENCONTRADO`. Un servidor puede agregar códigos propios.
4. Dinero: `{ monto: "1234.50", moneda: "USD" }`. Siempre un string con dos decimales; el servidor calcula en centavos enteros.
5. Fechas: `AAAA-MM-DD`; instantes en ISO 8601 UTC.
6. Convención de nombres: lecturas con prefijo `listar_`, `obtener_`, `consultar_`, `resumen_`, `ranking_`, `serie_`, `detectar_`, `sugerir_` o `consumir_`. Escrituras en pares `preparar_X` / `confirmar_X`.

## 2. Capacidades y tools

Las métricas y los eventos son capacidades opt-in: el servidor declara cuáles ofrece (`capacidades`, por ejemplo `['metricas', 'eventos']`) y `verificarConformidad(tools, { capacidades })` exige solo las tools de las que declaró. Si no declara capacidades se asumen todas (comportamiento de v0.1.0).

| Capacidad | Tool | Para qué |
|---|---|---|
| `metricas` | `listar_metricas` | Catálogo de métricas de la capa semántica (`id`, `etiqueta`, `descripcion`, `unidad`). |
| `metricas` | `consultar_metrica` | Valores de una o más métricas en un período, con comparación opcional contra el período anterior. |
| `eventos` | `consumir_eventos` | Eventos del ERP con cursor. Sin cursor devuelve la posición actual y ningún evento, para no inundar al primer consumidor. |

Un servidor con `capacidades: []` solo necesita cumplir las reglas generales y los pares `preparar_`/`confirmar_`.

Opcionales con forma definida: `serie_metrica` (serie temporal) y `detectar_anomalias` (desvíos con motivo y evidencia).

## 3. Salidas de lectura

Las lecturas devuelven una de tres formas, que los componentes genéricos saben dibujar:

- **Tabla** (`SalidaTabla`): `{ titulo?, columnas: [{ id, etiqueta, tipo? }], filas: [{...}], total_filas? }`.
- **Detalle** (`SalidaDetalle`): `{ titulo, campos: [{ etiqueta, valor }] }`.
- **Serie** (`SalidaSerie`): `{ titulo?, unidad, puntos: [{ x, y }] }`.

El orquestador guarda la lectura en el `ProposalStore` y el modelo recibe un `source_id`. Los datos que se muestran salen de esa fuente, no de lo que el modelo escriba.

## 4. Escrituras: preparar y confirmar

Cada escritura se expone como un par. Nada cambia hasta que la persona confirma.

### `preparar_X`

Valida, calcula y **guarda** una propuesta del lado del servidor. No tiene efectos. Devuelve:

```json
{
  "proposal_id": "prop_...",
  "confirmation_token": "cft_...",
  "expira_en": "2026-03-31T12:10:00.000Z",
  "titulo": "Orden de compra a Proveedor Norte",
  "resumen": [{ "etiqueta": "Plazo", "valor": "5 días" }],
  "lineas": [{ "descripcion": "...", "cantidad": "18", "precio_unitario": {...}, "importe": {...} }],
  "total": { "monto": "846.00", "moneda": "USD" },
  "advertencias": ["..."],
  "step_up": "supervisor",
  "requiere_step_up": true
}
```

- `confirmation_token` es secreto. Va **solo** a la superficie de la persona. El orquestador lo guarda en el `ProposalStore` y nunca se lo pasa al modelo.
- `total` y los importes de las líneas los calcula el servidor.
- `step_up` declara qué pide la confirmación además del token (ver «Step-up» más abajo): `none`, `motivo`, `supervisor` o `supervisor_y_motivo`. Sin el campo vale `requiere_step_up`.
- `requiere_step_up: true` es el campo anterior y equivale a `step_up: "supervisor"`. Un servidor que declara `supervisor` o `supervisor_y_motivo` envía también `requiere_step_up: true` para los orquestadores que solo conocen ese campo; con `motivo` solo no lo envía (un motivo no es la autorización de otra persona).
- La propuesta vence (`expira_en`). Si el servidor la rechaza como vencida, no se puede revivir: hay que preparar de nuevo.

### `confirmar_X`

Entrada: `{ contexto, proposal_id, confirmation_token, idempotency_key, autorizacion?: { usuario?, pin?, motivo? } }`.

El servidor debe, en este orden:

1. Verificar el rol del contexto.
2. Encontrar la propuesta (`PROPUESTA_NO_ENCONTRADA`).
3. Comparar el token en tiempo constante (`TOKEN_INVALIDO`).
4. Si ya estaba confirmada: con la misma `idempotency_key` devolver el mismo resultado con `idempotente: true`; con otra, `PROPUESTA_YA_CONFIRMADA`.
5. Verificar vencimiento (`PROPUESTA_EXPIRADA`).
6. Si la propuesta tiene step-up: exigir lo que pide su nivel en `autorizacion` (`STEP_UP_REQUERIDO` si falta) y validarlo (`AUTORIZACION_INVALIDA` si el usuario o el PIN no sirven, `PARAMETRO_INVALIDO` si el motivo no cumple el largo). El PIN lo verifica el servidor; el orquestador solo lo transporta.
7. Aplicar el efecto **a lo que dice la propuesta guardada**, nunca a datos que vengan en la confirmación.

Salida: `{ estado: "confirmado", idempotente, resultado, mensaje }`.

### Step-up

| `step_up` | La pantalla pide | `autorizacion` que viaja en `confirmar_*` |
|---|---|---|
| `none` | solo el toque de la persona | no hace falta |
| `motivo` | un texto obligatorio (hasta 200 caracteres) | `{ motivo }` |
| `supervisor` | usuario y PIN de otra persona con rol superior | `{ usuario, pin }` |
| `supervisor_y_motivo` | las dos cosas | `{ usuario, pin, motivo }` |

- `autorizacion` (el valor anterior de la acción de la tarjeta) sigue aceptándose como alias de `supervisor`.
- El PIN y el motivo van de la pantalla al servidor dentro de `ui.action` → `confirmar_*`. **Nunca entran al modelo** y el PIN **nunca queda en las trazas** (`redactar` y `quitarSecretos` cubren cualquier campo `pin`). El motivo sí puede quedar en trazas y en la auditoría del servidor.
- El orquestador solo comprueba que no falte nada y pasa al servidor únicamente lo que el nivel pide. Quién puede autorizar, que sea otra persona y que el PIN sea correcto lo decide el servidor.
- Una confirmación rechazada por falta de step-up o por un PIN incorrecto **no consume** la propuesta: se puede reintentar.
- `pin.ts` incluye una referencia para guardar y verificar PIN: `hashPin(pin, sal?)` (scrypt, formato `sal:hash`) y `verificarPin(pin, hash)` (comparación en tiempo constante). Verificá siempre, aunque el usuario no exista (contra un hash de relleno), para que el tiempo de respuesta no delate qué usuarios hay.

El orquestador **no expone** `confirmar_*` al modelo. Las llama el `Confirmador`, a pedido de la persona (`ui.action` con `action_id: "confirmar"`).

## 5. Conformidad

`verificarConformidad(tools)` revisa, sin ejecutar nada: tools de las capacidades declaradas presentes, `contexto` requerido en todas, pares `preparar_`/`confirmar_` completos, la entrada de `confirmar_` con token e idempotencia, y que ningún campo con nombre de secreto (`pin`, `password`, `secret`) aparezca fuera de las tools `confirmar_*` (donde viaja dentro de `autorizacion`, junto con el motivo). Un servidor que no pasa esa verificación no se conecta.

## 6. Kit de servidor conforme

`@agentic-erp/mcp-contract` exporta las piezas que todo `preparar_*` / `confirmar_*` necesita, para no reescribirlas (son una referencia: un servidor puede hacerlas distinto mientras cumpla este documento):

| Función | Para qué |
|---|---|
| `canonico(obj)` | JSON canónico: claves ordenadas en todos los niveles, sin claves `undefined`. |
| `hashPayload(obj)` | SHA-256 (hex) del JSON canónico. Guardalo con la propuesta y recalculalo al confirmar: si no coincide, la propuesta fue alterada. |
| `emitirToken()` | Token de confirmación aleatorio con prefijo `cft_`. |
| `tokenCoincide(a, b)` | Comparación en tiempo constante, también con largos distintos. |
| `claveIdempotencia(contexto, proposalId)` | Clave derivada (misma persona, tenant y propuesta, misma clave) para cuando la superficie no manda la suya. |
| `hashEntrada(entrada)` | Hash de la entrada de una operación sin secretos (token, PIN), sin la clave de idempotencia y sin el contexto. |
| `RegistroIdempotencia` | Puerto de la tabla de idempotencia (`obtener` / `guardar`, aislado por tenant). `RegistroIdempotenciaMemoria` es la versión para pruebas. |
| `consultarIdempotencia` / `registrarIdempotencia` | Resuelven los tres casos: clave nueva (`nueva`), repetición exacta (`repetida`: devolver el resultado guardado con `idempotente: true`) y misma clave con otra entrada (`conflicto`: rechazar con `PARAMETRO_INVALIDO`). |

Un `confirmar_*` típico: verificar rol, encontrar la propuesta, `tokenCoincide`, `consultarIdempotencia`, vencimiento, step-up, aplicar el efecto de la propuesta guardada y `registrarIdempotencia`. Ver `examples/erp-sintetico/src/erp.ts`. Guardá el resultado de idempotencia solo cuando el efecto se aplicó: un PIN incorrecto o un token inválido no deben consumir la clave.

## 7. Versionado

El contrato sigue SemVer. Agregar una tool opcional o un campo opcional es menor. Cambiar la forma de una salida o un código de error es mayor. La versión mayor vive en el `$id` de `schema/contract.schema.json` (hoy `v0`: el contrato puede cambiar hasta la 1.0).
