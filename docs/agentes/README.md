# Agentes por área

Un agente de área es una pieza acotada del orquestador: tiene su prompt (el playbook), hasta 15 tools y una lista de componentes que puede emitir. Hay **un solo orquestador** y **un agente por área**; los agentes no se hablan entre sí y comparten solo la memoria de la intención que mantiene el orquestador (ver [ADR-002](../adr/ADR-002-un-orquestador.md)). El router decide qué áreas toca cada frase y, si toca varias, corre los agentes en orden fijo.

Cada área vive en su carpeta, en [`examples/erp-sintetico/src/agentes/`](../../examples/erp-sintetico/src/agentes/):

- `agente.ts`: nombre, dominio, tools y componentes.
- `playbook.md`: el prompt del agente, tal cual. Se lee al arrancar y es el texto que recibe el modelo (junto con las reglas duras comunes que antepone `definirAgente`), así que no lleva títulos ni prosa de documentación.

## Áreas

| Área | Qué resuelve | Escribe | Playbook | Página |
|---|---|---|---|---|
| Ventas | Indicadores, ranking de artículos, tendencias, desgloses y anomalías | No | [playbook](../../examples/erp-sintetico/src/agentes/ventas/playbook.md) | [ventas](ventas.md) |
| Stock | Existencias, artículos bajo el mínimo, ficha de un artículo y ajustes de inventario | Sí: ajustes de existencia | [playbook](../../examples/erp-sintetico/src/agentes/stock/playbook.md) | [stock](stock.md) |
| Compras | Proveedores, órdenes de compra y qué reponer | Sí: órdenes de compra | [playbook](../../examples/erp-sintetico/src/agentes/compras/playbook.md) | [compras](compras.md) |
| Caja | Estado de la caja, movimientos, arqueos y diferencias | Sí: ingresos y egresos | [playbook](../../examples/erp-sintetico/src/agentes/caja/playbook.md) | [caja](caja.md) |

Ningún agente escribe por su cuenta. Las tools `preparar_*` solo arman una propuesta; la confirmación (`confirmar_*`) la hace la persona desde la pantalla, y el agente no tiene acceso a ninguna tool de confirmación.

## Frases de ejemplo probadas

Cada frase que figura en las páginas de área existe en [`evals/frases.json`](../../evals/frases.json), así que `npm run eval` verifica que el router la mande al área indicada, que el agente use las tools esperadas y que termine en el componente que se describe. Una prueba (`examples/erp-sintetico/tests/agentes.test.ts`) falla si una página cita una frase que no está en los evals. El formato es una línea que empieza con `> ` dentro de la sección "Qué le podés pedir".

## Cómo sumar un área

1. **Tools en el ERP.** Agregá las lecturas y, si hay escritura, el par `preparar_*` / `confirmar_*` en [`erp.ts`](../../examples/erp-sintetico/src/erp.ts) y registralas en `TOOLS` de [`servidor.ts`](../../examples/erp-sintetico/src/servidor.ts). El servidor es la autoridad: calcula los importes y vuelve a verificar permisos.
2. **Carpeta del agente.** Creá `examples/erp-sintetico/src/agentes/<area>/` con `agente.ts` (usá `definirAgente`, `COMUNES` y `leerPlaybook(import.meta.url)`, como las áreas existentes) y `playbook.md` con el prompt. Máximo 15 tools y ninguna `confirmar_*`; si el área necesita más, partila en dos.
3. **Registro.** Exportá el agente desde [`agentes/index.ts`](../../examples/erp-sintetico/src/agentes/index.ts) y sumalo a `REGISTRO_AGENTES`.
4. **Router.** Sumá el dominio a `DOMINIOS` y sus reglas a `REGLAS` en [`reglas.ts`](../../examples/erp-sintetico/src/reglas.ts). Las reglas van sin tildes y deliberadamente estrechas; lo ambiguo lo resuelve el clasificador con el modelo.
5. **Permisos.** Si el área escribe, agregá cada `preparar_*` con sus roles a `ROLES_POR_ESCRITURA` en [`permisos.ts`](../../examples/erp-sintetico/src/permisos.ts), y definí si pide step-up.
6. **Evals.** Agregá frases con su guion en [`evals/frases.json`](../../evals/frases.json) (lecturas, la escritura, un faltante de datos y un error) y corré `npm run eval`.
7. **Página del área.** Escribí `docs/agentes/<area>.md` con el mismo formato que las otras y sumala a la tabla de arriba. Las frases citadas tienen que estar en los evals.
8. **Verificación.** `npm run check` (tipos, pruebas y evals).
