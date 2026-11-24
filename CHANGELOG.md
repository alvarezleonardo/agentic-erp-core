# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado semántico.

## [0.2.0] - 2026-11-24

### Agregado

- Agentes por área: cada área del ERP sintético vive en `examples/erp-sintetico/src/agentes/<área>/` con `agente.ts` y su `playbook.md` (el prompt que recibe el modelo). Una prueba verifica que cada playbook solo nombre tools de su agente.
- Catálogo `docs/agentes/`: una página por área con frases de ejemplo, qué ve la persona y si pide confirmación de alguien. Cada frase citada existe en los evals (lo verifica una prueba). Incluye cómo sumar un área y el mapa de las diez.
- Seis áreas nuevas en el ERP sintético, cada una con datos deterministas, tools, agente, reglas del router, permisos, pruebas y evals:
  - Facturación: clientes, facturas con saldo y notas de crédito con motivo obligatorio.
  - Clientes y cobranzas: estado de cuenta, deudores por antigüedad y cobros imputados a las facturas más viejas.
  - Pagos a proveedores: cuentas a pagar, agenda de vencimientos y pagos (solo supervisor y gerente). Ante proveedores homónimos el agente pregunta.
  - Tesorería y bancos: cuentas en USD y ARS, conciliación de los depósitos de caja contra el banco, posición por moneda y transferencias internas.
  - Precios y listas: listas Minorista, Mayorista y Distribuidores, historial, margen bajo y cambios de precio por valor, porcentaje o margen objetivo.
  - Gestión del día (solo lectura): cierre del día, resumen del período y alertas de todas las áreas con quién resuelve cada una. Corre también por comando, sin pasar por el modelo.
- Cada escritura nueva es un par `preparar_*` / `confirmar_*` con el importe calculado por el servidor y confirmación de un supervisor (y motivo, según el caso) por umbrales configurables.

### Cambiado

- Evals dorados: de 31 a 73 frases, todas en verde con el LLM guionado.

## [0.1.2] - 2026-11-24

### Agregado

- `docs/ejemplos/auditoria.md`: tres trazas completas de una corrida real (camino feliz, autorización inválida y reintento con la misma clave de idempotencia), que se regeneran con `npm run ejemplo:auditoria`.

### Cambiado

- Los textos, la salida de la demo y la demo grabada nombran a quien confirma (por ejemplo, `supervisor1`) y hablan de las credenciales de la confirmación. El contrato técnico no cambia.

## [0.1.1] - 2026-11-16

### Corregido

- ERP sintético: la advertencia de la `ConfirmationCard` de caja usa los umbrales configurados en `umbralesCaja` en vez de un "500.00" fijo.

### Agregado

- La demo muestra la traza de auditoría (cantidad de eventos) y suma una quinta garantía: la traza no contiene el token ni la credencial de confirmación.
- Demo grabada: el primer cuadro ya muestra contenido, el cierre dura más y se publican también `demo.mp4` y `demo-final.png`.
- README: sección "Dónde encaja en el ciclo agéntico", sección "Auditoría" con un extracto real de la traza y diagrama de arquitectura en vertical.
- ADR-002: la decisión en el vocabulario de la IA agéntica (arquitectura vertical con conductor), el costo aceptado y cómo se cortan las fallas en cascada.

## [0.1.0] - 2026-11-13

Primera versión pública.

### Agregado

- Núcleo (`@agentic-erp/core`): un orquestador con agentes de dominio (hasta 15 tools cada uno), router híbrido reglas + LLM, `AgentRunner`, `ProposalStore`, `Compositor`, `Confirmador`, memoria, permisos y trazas.
- Separación estricta proponer/confirmar: el modelo solo llama `preparar_*`; solo el `Confirmador` llama `confirmar_*` ante un `ui.action` de la persona.
- El servidor pone los montos; tokens y credenciales de confirmación no llegan al modelo ni a las trazas.
- Toda corrida termina en `render_ui`, `clarify` o `report_error`.
- **Modo directo** (protocolo de cliente 1.1): `user.input` puede traer `comando: { tool, args }` en vez de texto. El `Orquestador` ejecuta la tool sin pasar por el modelo, con los mismos permisos, contexto e idempotencia; rechaza siempre `confirmar_*` (`COMANDO_NO_PERMITIDO`); un `preparar_*` sigue el camino de propuesta (`ProposalStore` y `ConfirmationCard` hidratada). Las lecturas se muestran con el componente registrado en `componentesPorTool` o, por defecto, `DetailCard` (objeto) o `DataTable` (lista).
- **Step-up**: `step_up` es `none | motivo | supervisor | supervisor_y_motivo` en la propuesta, la `ConfirmationCard` y las acciones (`autorizacion` se acepta como alias de `supervisor`). La credencial y el motivo viajan en `confirmar_*` (dentro de `autorizacion`); el motivo puede quedar en trazas y auditoría, la credencial de confirmación nunca.
- `@agentic-erp/llm`: interfaz `LlmProvider`, `ScriptedProvider`, presupuesto de gasto y adaptador compatible con `/chat/completions`.
- `@agentic-erp/mcp-contract`: tipos, JSON Schema, verificación de conformidad y `CONTRACT.md`; verificación de credenciales de referencia (scrypt, tiempo constante) y los helpers `stepUpDe`, `pideSupervisor`, `pideMotivo` y `faltanteDeStepUp`.
- **Kit de servidor conforme** en `mcp-contract`: `canonico`, `hashPayload`, `emitirToken`, `tokenCoincide`, `claveIdempotencia`, `hashEntrada`, el puerto `RegistroIdempotencia` con `RegistroIdempotenciaMemoria`, y `consultarIdempotencia` / `registrarIdempotencia`.
- `@agentic-erp/mcp-client`: cliente MCP (stdio, HTTP, en memoria) y cliente compuesto.
- `contracts/genui`: componentes genéricos versionados (JSON Schema). El mensaje de cliente acepta `v` `1.0` y `1.1` (`comando` exige `1.1`); el sobre del servidor está en `1.0`.
- ERP sintético de ejemplo (ventas, stock, compras, caja) sobre el kit, con 4 agentes y reglas del router. Egresos de caja desde 500.00 piden supervisor, desde 2000.00 supervisor y motivo, e ingresos desde 500.00 piden motivo (umbrales configurables). Las credenciales de los autorizadores se guardan con scrypt y nadie puede autorizarse a sí mismo.
- Demo de terminal (`npm run demo`, `docs/demo/demo.gif`): propuesta, credencial del supervisor y escritura, offline con LLM guionado.
- 31 evals dorados offline con desglose por router, plan, tools y componente, más tokens y costo de la corrida cuando se corren contra un modelo real con tope de gasto.
- Pruebas de seguridad de punta a punta, ADRs, CI en GitHub Actions y plantillas de comunidad.
