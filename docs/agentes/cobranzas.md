# Clientes y cobranzas

Cuánto debe cada cliente, quiénes están atrasados y el registro de cobros.

Playbook: [`agentes/cobranzas/playbook.md`](../../examples/erp-sintetico/src/agentes/cobranzas/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/cobranzas/agente.ts).

## Tools

- Lectura: `buscar_clientes` (la misma tool que usa facturación; el servidor la expone una vez y cada agente la referencia por nombre), `estado_cuenta_cliente` (saldo, vencido, a vencer, límite de crédito, crédito disponible y cada factura con saldo), `listar_deudores` (clientes con saldo vencido y su deuda por antigüedad; se puede ordenar y filtrar por días) y `listar_cobranzas` (cobros registrados por cliente o período).
- Escritura: `preparar_cobranza`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_cobranza`, que el agente no tiene). Pueden prepararla los roles operador, supervisor y gerente.

## Componentes

`DetailCard`, `DataTable`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Datos

Clientes y facturas son los de facturación: esta área no los duplica. El saldo de una factura sigue siendo `importe - cobrado - acreditado`, y una cobranza solo suma a `cobrado`. La única entidad nueva es el cobro (`Cobranza`), con su medio, su importe y a qué facturas se imputó. Arranca vacío: los cobros anteriores solo figuran en el `cobrado` de cada factura, sin detalle. Los casos del ejemplo son los mismos de facturación: dos clientes Gómez (uno de cuenta corriente y otro de contado, sin deuda), un cliente que no paga y tiene todo vencido, y otro que supera su límite de crédito.

## Cómo calcula un cobro

- El servidor reparte el importe entre las facturas con saldo del cliente, de la más vieja a la más nueva por fecha de emisión, y calcula el saldo que queda en cada una y en total. El agente no calcula nada.
- Cada factura pasa a parcialmente cobrada o cobrada según lo que reciba. Al confirmar, el servidor vuelve a repartir contra el estado real: si la deuda cambió desde que se preparó la propuesta y ya no alcanza, rechaza.
- Un importe mayor a la deuda se rechaza. Este ejemplo no maneja anticipos ni saldo a favor, y un cliente sin facturas con saldo (los de contado) tampoco admite un cobro.
- Si el medio es efectivo, al confirmar el servidor deja además un ingreso en la caja de hoy con el concepto «Cobranza <cliente>». Con transferencia o cheque no se toca la caja.
- La antigüedad de `listar_deudores` se cuenta en días desde la emisión de cada factura vencida, en tramos de 0-30, 31-60, 61-90 y más de 90 días. Con `antiguedad_minima` solo cuenta la deuda vencida de más de esos días. Se cuenta desde la emisión y no desde el vencimiento porque con los datos del ejemplo ninguna factura lleva más de 60 días vencida.

## Cuándo pide un supervisor

Los cobros de 5.000,00 o más piden la confirmación de un supervisor; el umbral se configura al crear el ERP (`umbralCobranza`). Los menores no lo piden: son plata que entra, el importe y las facturas imputadas quedan en la propuesta que la persona ve antes de confirmar, y el cobro en efectivo deja su ingreso en la caja. Un cobro mal cargado sí cancela deuda de un cliente, y por eso el umbral deja los importes grandes bajo doble control. Ninguna cobranza pide motivo.

## Qué le podés pedir

> cuánto nos debe Distribuidora Norte

Ve el estado de cuenta (`DetailCard`): saldo, vencido, a vencer y cuánto se pasó del límite de crédito. No pide confirmación.

> quiénes nos deben más de 60 días

Ve los clientes con deuda vencida de más de 60 días desde la emisión, con la deuda por tramo (`DataTable`). No pide confirmación.

> registrá un cobro de 1500 por transferencia de Colegio San Martín

Ve cómo se reparte el cobro entre sus facturas más viejas y la deuda que queda (`ConfirmationCard`). No pide un supervisor porque está por debajo del umbral.

> registrá un cobro de 8000 en cheque de Distribuidora Norte

Igual que el anterior, pero el importe supera el umbral y la pantalla pide además la confirmación de un supervisor.

> cobré en efectivo a Gómez

Hay dos clientes con ese apellido, así que el agente pregunta cuál (`Clarification`) y no elige. Además falta el importe, que se pide después.

> registrá un cobro de Colegio San Martín

Faltan el medio y el importe, así que el agente los pide (`FormCard`) en lugar de inventarlos.

> qué nos adeuda el Taller Mecánico Ibarra

Esta frase no la resuelve una regla del router sino el modelo, que la manda al área de cobranzas. Ve el estado de cuenta (`DetailCard`).
