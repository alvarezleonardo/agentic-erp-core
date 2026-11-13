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
