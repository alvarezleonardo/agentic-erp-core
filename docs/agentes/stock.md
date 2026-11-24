# Stock

Existencias, artículos bajo el mínimo y ajustes de inventario.

Playbook: [`agentes/stock/playbook.md`](../../examples/erp-sintetico/src/agentes/stock/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/stock/agente.ts).

## Tools

- Lectura: `buscar_articulos`, `listar_stock`, `obtener_articulo`.
- Escritura: `preparar_ajuste_stock`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_ajuste_stock`, que el agente no tiene). Pueden prepararla los roles operador, supervisor y gerente.

## Componentes

`DataTable`, `DetailCard`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Qué le podés pedir

> qué artículos están bajo el mínimo

Ve la lista de artículos con existencia menor al mínimo (`DataTable`). No pide confirmación.

> cuánto stock hay de teclados

Ve la ficha del artículo (`DetailCard`). No pide confirmación.

> ajustá el stock del teclado mecánico a 12 unidades por conteo físico

Ve la propuesta de ajuste para revisar (`ConfirmationCard`). Pide la confirmación de quien lo pidió; no hace falta un supervisor.

> ajustá el stock de accesorios

Si el nombre calza con varios artículos, el agente no elige: pregunta cuál (`Clarification`).

> ajustá el stock del teclado a 12

Si falta el motivo, el agente lo pide en un formulario y no lo inventa (`FormCard`).

> ajustá el stock del escritorio gamer a 3 por conteo

Si no hay ningún artículo con ese nombre, avisa que no lo encontró (`ErrorNotice`) y no prepara nada.
