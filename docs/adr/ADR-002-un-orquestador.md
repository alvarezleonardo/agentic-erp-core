# ADR-002: Un orquestador con agentes acotados, no un enjambre

- Estado: aceptada
- Relacionada con: ADR-001

## Contexto

Hay que cubrir varias áreas de un ERP (ventas, stock, compras, caja, y las que se sumen). Con decenas de tools en un solo prompt, el modelo elige peor y es más fácil que use una que no corresponde. La tentación opuesta es un enjambre de agentes que se hablan entre sí.

## Decisión

**Un solo orquestador** con **agentes de dominio acotados**:

- Cada agente tiene su prompt, **hasta 15 tools** (lo impone `definirAgente`) y una lista de componentes que puede emitir. Si un dominio necesita más, se parte en dos.
- Un **router híbrido** decide qué dominios toca cada frase: reglas con expresiones regulares (rápidas, auditables, sin costo de modelo) y, si no alcanzan, un clasificador con el modelo por llamada a función (`plan_intent`). Si ninguno clasifica, se le pregunta a la persona.
- Los agentes **no se hablan entre sí**. Comparten solo la memoria de la intención (qué se resolvió, qué foco hay) que mantiene el orquestador. Una frase que toca varias áreas corre los agentes en orden fijo.
- Cada agente corre en un bucle acotado (6 pasos) y termina siempre con una directiva final validada contra el esquema.

## Alternativas descartadas

1. **Un agente único con todas las tools.** Simple, pero a partir de unas pocas decenas de tools se degrada la elección y crece el prompt. Mezclar escrituras de áreas distintas aumenta el daño posible de un error.
2. **Enjambre o delegación libre entre agentes.** Hace opaco el flujo, multiplica llamadas y costo, y vuelve difícil probar y reproducir. Un agente que delega puede escalar permisos sin que nadie lo decida.
3. **Router solo con modelo.** Flexible, pero cada frase paga una llamada, la latencia sube y el comportamiento es menos predecible. Las reglas cubren lo frecuente y se auditan en un archivo.
4. **Router solo con reglas.** Barato y predecible, pero frágil ante lenguaje libre. El modelo queda como respaldo.
5. **Planificador que genera un plan arbitrario de tools.** Da más libertad de la necesaria; el conjunto de dominios y tools por agente es un contrato revisable.

## Consecuencias

- Agregar un área = agregar un agente, reglas del router y, si hace falta, un hidratador. No se toca el núcleo.
- El costo por frase es predecible: 0 llamadas para el router cuando matchean las reglas, más las del agente (acotadas por el tope de pasos y el presupuesto).
- Las frases que cruzan áreas son más lentas (agentes en secuencia) pero auditables paso por paso en la traza.

## En el vocabulario de la IA agéntica

Esta decisión es lo que [IBM](https://www.ibm.com/mx-es/think/topics/agentic-ai) llama una arquitectura vertical: un modelo "conductor" supervisa agentes más simples. Acá el conductor es el `Orquestador` junto con el `Router`, y los agentes más simples son los de dominio. La alternativa horizontal, agentes pares descentralizados, es la que el punto 2 de las alternativas descartadas rechaza.

### Costo aceptado

IBM señala que la arquitectura vertical es buena para flujos secuenciales pero tiende a cuellos de botella. Se acepta:

- Todo pasa por un solo punto: el `Orquestador` ejecuta los agentes del plan de a uno y espera cada salida antes de pasar al siguiente (`ejecutarPlan`). No hay ejecución en paralelo.
- La latencia de una frase que cruza áreas es la suma de las corridas de cada agente, cada una de hasta 6 pasos (`MAX_PASOS_POR_AGENTE`).

A cambio se obtiene un flujo auditable paso por paso en la traza (`Trace`) y reproducible.

### Cómo se cortan las fallas en cascada

IBM advierte que en sistemas multiagente las fallas pueden desencadenarse en cascada. En este diseño se cortan así:

- **Los agentes no se hablan.** Un agente no recibe la salida cruda de otro: el siguiente solo ve la lista de dominios ya resueltos y los ids que guardó `MemoriaIntencion`, que no guarda montos. Un error de un agente no se propaga como entrada de otro.
- **Toda corrida termina en una directiva final** (`render_ui`, `clarify` o `report_error`), validada por el `Compositor`. `AgentRunner` devuelve siempre una `SalidaAgente`: si la directiva no valida, hay un único reintento y después `UI_INVALIDA`; si se agotan los pasos, `TOPE_DE_PASOS`.
- **Un error de tool no rompe la corrida.** El resultado con error vuelve al modelo como resultado de la tool y su código queda registrado; el agente puede reintentar o terminar. Si termina con `report_error`, el código solo puede ser uno que devolvió una tool en esa intención o `AGENTE_SIN_RESOLUCION`: uno inventado se reemplaza y queda en la traza. La acción sugerida por el servidor, si es apta para personas, gana sobre el texto del modelo.
- **Si el modelo cae o se agota el presupuesto**, el `AgentRunner` captura el error y devuelve un `ErrorNotice` con código `LLM_NO_DISPONIBLE` (reintentable) o `PRESUPUESTO_AGOTADO` (no reintentable), en vez de dejar la corrida en el aire.
- **El plan se detiene ante un error.** Si un agente termina en error o la persona cancela, el `Orquestador` corta el plan: los agentes que faltaban no corren.

### Pruebas que lo cubren

En `packages/core/tests/runner.test.ts`:

- "corta en el tope de pasos con un ErrorNotice reintentable (nunca queda en el aire)"
- "toda corrida termina en render_ui, clarify o report_error, incluso si el modelo falla" (cubre `LLM_NO_DISPONIBLE` y `PRESUPUESTO_AGOTADO`)
- "si la directiva final no valida, da un único reintento y después falla con UI_INVALIDA"
- "un report_error con un código inventado se reemplaza; con uno real de un tool se respeta y trae la acción del servidor"
- "bloquea tools de otro dominio y las que el rol no puede usar"

No hay una prueba específica de que el `Orquestador` corte el plan y deje sin correr a los agentes restantes tras un error: ese comportamiento hoy se verifica solo por lectura del código.
