# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado semántico.

## [0.1.0] - 2026-11-13

Primera versión pública.

### Agregado

- Núcleo (`@agentic-erp/core`): un orquestador con agentes de dominio (hasta 15 tools cada uno), router híbrido reglas + LLM, `AgentRunner`, `ProposalStore`, `Compositor`, `Confirmador`, memoria, permisos y trazas.
- Separación estricta proponer/confirmar: el modelo solo llama `preparar_*`; solo el `Confirmador` llama `confirmar_*` ante un `ui.action` de la persona.
- El servidor pone los montos; tokens y PIN no llegan al modelo ni a las trazas.
- Toda corrida termina en `render_ui`, `clarify` o `report_error`.
- **Modo directo** (protocolo de cliente 1.1): `user.input` puede traer `comando: { tool, args }` en vez de texto. El `Orquestador` ejecuta la tool sin pasar por el modelo, con los mismos permisos, contexto e idempotencia; rechaza siempre `confirmar_*` (`COMANDO_NO_PERMITIDO`); un `preparar_*` sigue el camino de propuesta (`ProposalStore` y `ConfirmationCard` hidratada). Las lecturas se muestran con el componente registrado en `componentesPorTool` o, por defecto, `DetailCard` (objeto) o `DataTable` (lista).
- **Step-up**: `step_up` es `none | motivo | supervisor | supervisor_y_motivo` en la propuesta, la `ConfirmationCard` y las acciones (`autorizacion` se acepta como alias de `supervisor`). El PIN y el motivo viajan en `confirmar_*` (`autorizacion: { usuario, pin, motivo }`); el motivo puede quedar en trazas y auditoría, el PIN nunca.
- `@agentic-erp/llm`: interfaz `LlmProvider`, `ScriptedProvider`, presupuesto de gasto y adaptador compatible con `/chat/completions`.
- `@agentic-erp/mcp-contract`: tipos, JSON Schema, verificación de conformidad y `CONTRACT.md`; `hashPin` y `verificarPin` (scrypt, tiempo constante) y los helpers `stepUpDe`, `pideSupervisor`, `pideMotivo` y `faltanteDeStepUp`.
- **Kit de servidor conforme** en `mcp-contract`: `canonico`, `hashPayload`, `emitirToken`, `tokenCoincide`, `claveIdempotencia`, `hashEntrada`, el puerto `RegistroIdempotencia` con `RegistroIdempotenciaMemoria`, y `consultarIdempotencia` / `registrarIdempotencia`.
- `@agentic-erp/mcp-client`: cliente MCP (stdio, HTTP, en memoria) y cliente compuesto.
- `contracts/genui`: componentes genéricos versionados (JSON Schema). El mensaje de cliente acepta `v` `1.0` y `1.1` (`comando` exige `1.1`); el sobre del servidor está en `1.0`.
- ERP sintético de ejemplo (ventas, stock, compras, caja) sobre el kit, con 4 agentes y reglas del router. Egresos de caja desde 500.00 piden supervisor, desde 2000.00 supervisor y motivo, e ingresos desde 500.00 piden motivo (umbrales configurables). Los PIN de los autorizadores se guardan con scrypt y nadie puede autorizarse a sí mismo.
- Demo de terminal (`npm run demo`, `docs/demo/demo.gif`): propuesta, PIN del supervisor y escritura, offline con LLM guionado.
- 31 evals dorados offline con desglose por router, plan, tools y componente, más tokens y costo de la corrida cuando se corren contra un modelo real con tope de gasto.
- Pruebas de seguridad de punta a punta, ADRs, CI en GitHub Actions y plantillas de comunidad.
