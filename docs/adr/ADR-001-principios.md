# ADR-001: Principios del núcleo

- Estado: aceptada
- Alcance: todo `agentic-erp-core`

## Contexto

Un ERP guarda dinero, existencias y obligaciones. Un agente con modelo de lenguaje puede leer ese dato y armar una acción, pero también puede equivocarse, inventar una cifra o ser engañado por un texto. La capa agéntica tiene que ser útil sin ampliar la superficie de riesgo del sistema que ya existe.

## Decisión

Seis principios. Cada uno tiene un mecanismo concreto en el código y una prueba que lo sostiene.

1. **El agente propone y la persona decide.** Las escrituras se dividen en `preparar_*` (sin efecto) y `confirmar_*`. Solo el `Confirmador`, a pedido de la persona desde la pantalla, llama a `confirmar_*`. `definirAgente` rechaza cualquier agente que declare una tool de confirmación, y el `AgentRunner` la bloquea si el modelo la inventa.
2. **El servidor pone los montos.** El modelo no calcula ni escribe importes. El `Compositor` hidrata la pantalla desde la salida de las tools; descarta lo que el modelo escriba en campos `x-source` y el `speech` que contenga una cifra.
3. **El modelo nunca ve secretos de confirmación.** El token vive en el `ProposalStore`. Lo que se le entrega al modelo pasa por `paraLlm`, que lo quita. El PIN de un step-up viaja de la pantalla al servidor y no entra en las trazas.
4. **Todo termina en una directiva final.** Cada corrida acaba en `render_ui`, `clarify` o `report_error`. Si el modelo falla, se agota el presupuesto o se alcanza el tope de pasos, la persona recibe un aviso de error, nunca un silencio. Los códigos de error inventados por el modelo se reemplazan por `AGENTE_SIN_RESOLUCION`.
5. **La pantalla es un catálogo cerrado.** Los componentes son genéricos, versionados y con JSON Schema (`contracts/genui`). Las acciones salen de un catálogo; que una acción confirme lo decide el catálogo, no el modelo.
6. **Defensa en profundidad.** Los permisos se verifican en el orquestador (para no mostrarle al modelo lo que la persona no puede usar) y de nuevo en el servidor (que es la autoridad). Las confirmaciones son idempotentes y el token se compara en tiempo constante.

## Consecuencias

- Más código en el borde (hidratadores, catálogo de acciones) a cambio de que la mentira de un modelo no llegue a la pantalla.
- Las escrituras requieren dos llamadas y un toque de la persona: más fricción, a propósito.
- Agregar un ERP implica cumplir el contrato MCP (`packages/mcp-contract/CONTRACT.md`); la verificación de conformidad lo comprueba.
