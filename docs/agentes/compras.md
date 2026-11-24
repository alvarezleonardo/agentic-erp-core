# Compras

Proveedores, órdenes de compra y qué reponer.

Playbook: [`agentes/compras/playbook.md`](../../examples/erp-sintetico/src/agentes/compras/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/compras/agente.ts).

## Tools

- Lectura: `listar_proveedores`, `listar_ordenes_compra`, `sugerir_compra`, `buscar_articulos`, `obtener_articulo`.
- Escritura: `preparar_orden_compra`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_orden_compra`, que el agente no tiene). Cada orden es de un solo proveedor. Pueden prepararla los roles supervisor y gerente; un operador recibe un aviso de permisos.

## Componentes

`DataTable`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Qué le podés pedir

> qué tengo que comprar

Ve la compra sugerida según los artículos bajo el mínimo (`DataTable`). No pide confirmación.

> las órdenes de compra pendientes

Ve las órdenes existentes (`DataTable`). No pide confirmación.

> qué proveedores tenemos

Ve los proveedores con su plazo de entrega (`DataTable`). No pide confirmación.

> sugerime la compra a Tecnoparts

Ve la sugerencia acotada a ese proveedor (`DataTable`). No pide confirmación.

> mostrame lo que hay bajo mínimo y qué tendría que comprar

Toca dos áreas: primero stock y después compras, en ese orden. Ve la tabla de la compra sugerida (`DataTable`).

> armame la orden de compra de los teclados a Tecnoparts, 18 unidades

Ve la orden propuesta para revisar (`ConfirmationCard`). Pide la confirmación de quien la armó (supervisor o gerente); las cantidades las dice la persona, el agente no las calcula.
