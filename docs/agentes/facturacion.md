# Facturación

Clientes, facturas de venta, total facturado y notas de crédito.

Playbook: [`agentes/facturacion/playbook.md`](../../examples/erp-sintetico/src/agentes/facturacion/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/facturacion/agente.ts).

## Tools

- Lectura: `buscar_clientes`, `listar_facturas` (por cliente, período, estado o solo con saldo), `obtener_factura` (por id o por número), `resumen_facturacion` (indicadores del período, o desglose por mes, cliente o tipo de comprobante).
- Escritura: `preparar_nota_credito`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_nota_credito`, que el agente no tiene). Pueden prepararla los roles operador, supervisor y gerente.

## Componentes

`DataTable`, `DetailCard`, `KpiTiles`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Datos

Los clientes y las facturas son datos del ejemplo, generados con una semilla propia: no desglosan las ventas del área de ventas, que el ERP sintético lleva por artículo y no por cliente. Cada factura tiene importe, lo cobrado y lo acreditado por notas de crédito; el saldo pendiente es la diferencia, y es lo que van a reutilizar las áreas de clientes y cobranzas. El ejemplo incluye dos clientes con el mismo apellido (Gómez Hnos. y Gómez, Laura), un cliente que no paga y tiene todo vencido, y otro que supera su límite de crédito.

## Cómo calcula la nota de crédito

- El importe lo calcula el servidor. Sin importe, la nota es total y vale el saldo de la factura; con un importe, es parcial y no puede superar ese saldo.
- El motivo es obligatorio. Si la persona no lo dijo, el agente lo pide con un formulario.
- Se rechazan las facturas anuladas y las que ya están cobradas por completo.
- Una nota total sobre una factura sin cobros la deja anulada; si ya tenía cobros, la deja cobrada.
- Las notas de crédito de 1.000,00 o más piden además la confirmación de un supervisor. El umbral se configura al crear el ERP (`umbralNotaCredito`). El servidor vuelve a verificar el saldo al confirmar, por si cambió desde que se preparó la propuesta.

## Qué le podés pedir

> qué facturamos este mes

Ve los indicadores del período con la comparación contra el período anterior (`KpiTiles`). No pide confirmación.

> las facturas pendientes de Gómez Hnos.

Ve las facturas con saldo de ese cliente (`DataTable`). No pide confirmación.

> mostrame la factura 0001-00001234

Ve el detalle de la factura (`DetailCard`). No pide confirmación.

> hacé una nota de crédito por la factura 0001-00001234 porque vino un artículo fallado

Ve la nota propuesta (`ConfirmationCard`). Con los datos del ejemplo el saldo de esa factura supera el umbral por defecto, así que pide además la confirmación de un supervisor.

> nota de crédito para Gómez

Hay dos clientes con ese apellido, así que el agente pregunta cuál (`Clarification`).

> hacé una nota de crédito por la factura 0001-00001234

Falta el motivo, así que el agente lo pide (`FormCard`) en lugar de inventarlo.

> qué le emitimos a Gómez Hnos. en marzo

Esta frase no la resuelve una regla del router sino el modelo, que la manda al área de facturación. Ve las facturas de ese cliente en el mes (`DataTable`).
