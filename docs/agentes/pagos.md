# Pagos a proveedores

Cuánto se le debe a cada proveedor, qué vence y el registro de pagos.

Playbook: [`agentes/pagos/playbook.md`](../../examples/erp-sintetico/src/agentes/pagos/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/pagos/agente.ts).

## Tools

- Lectura: `buscar_proveedores` (nombre, plazo y saldo a pagar de cada coincidencia), `estado_cuenta_proveedor` (saldo, vencido, lo que vence esta semana y después, pagos a la espera del débito bancario y cada factura con saldo), `listar_cuentas_a_pagar` (facturas con saldo de un proveedor, solo las vencidas o las que vencen en N días), `vencimientos_proximos` (la agenda de pagos de los próximos N días, con el total en el título y lo que ya está vencido) y `listar_pagos_proveedor` (pagos registrados, con su estado bancario).
- Escritura: `preparar_pago_proveedor`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_pago_proveedor`, que el agente no tiene). Pueden prepararla los roles supervisor y gerente: un operador recibe el aviso de que no tiene permiso.

## Componentes

`DetailCard`, `DataTable`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Datos

Los proveedores y las órdenes de compra son los de compras; esta área suma las facturas de proveedor (`FacturaProveedor`) y el pago (`PagoProveedor`). Igual que en facturación, el saldo de una factura no se guarda: es `importe - pagado`, y un pago solo suma a `pagado`. Algunas facturas se vinculan a una orden de compra recibida y llevan el total de la orden. Los pagos arrancan vacíos: lo pagado antes figura solo en `pagado`, sin detalle. Casos sembrados:

- Dos proveedores Gómez, «Gómez Insumos SA» (tres facturas) y «Gómez, Ricardo» (una): «Gómez» a secas es ambiguo.
- Facturas vencidas de varios proveedores, otras que vencen hoy o esta semana, y otras que vencen después. La fecha de referencia es el martes 31/03/2026, así que «esta semana» llega hasta el domingo 05/04/2026.
- Una factura de Aurora con un pago parcial previo.
- Una anomalía: una factura de Tecnoparts cargada dos veces (mismo número e importe). La propuesta de pago lo advierte.

## Cómo calcula un pago

- La persona puede indicar un importe, unas facturas concretas (por su número) o un alcance: `vencidas` o `vencen_esta_semana` (las que vencen entre hoy y el domingo; no incluye las ya vencidas). Con facturas o alcance y sin importe se paga el saldo completo de ese conjunto; con importe, se imputa dentro del conjunto.
- El servidor reparte el importe de la factura que vence primero a la que vence último y calcula el saldo que queda en cada una y en total. El agente no calcula nada.
- Un importe mayor a la deuda del conjunto se rechaza. Este ejemplo no maneja anticipos a proveedores. Al confirmar, el servidor vuelve a repartir contra el estado real: si la deuda cambió desde que se preparó la propuesta y ya no alcanza, rechaza.
- Si el medio es efectivo, al confirmar el servidor deja además un egreso en la caja de hoy con el concepto «Pago proveedor <proveedor>». Con transferencia no toca la caja: el pago queda registrado con estado `pendiente_debito` a la espera del débito bancario. El área de [tesorería](tesoreria.md) lo suma en la posición como pendiente de débito; este ejemplo no registra el débito en el extracto bancario.

## Cuándo pide un supervisor

Los pagos de 1.000,00 o más piden la confirmación de un supervisor, y los de 5.000,00 o más piden además un motivo. Los dos umbrales se configuran al crear el ERP (`umbralPagoProveedor` y `umbralMotivoPagoProveedor`). Un pago en efectivo también es un egreso de caja, así que rige el más estricto entre estos umbrales y los de caja (500,00 para el supervisor y 2.000,00 para supervisor y motivo). Quien confirma tiene que ser otra persona con rol de supervisor o gerente: nadie se autoriza a sí mismo.

## Qué le podés pedir

> qué pagos vencen esta semana

Ve la agenda de pagos de los próximos días (`DataTable`), con el total en el título y cuánto hay vencido sin pagar. No pide confirmación.

> cuánto le debemos a Gómez Insumos

Ve el estado de cuenta del proveedor (`DetailCard`): saldo, vencido, lo que vence esta semana y después. No pide confirmación.

> pagale a Gómez

Hay dos proveedores con ese apellido, así que el agente pregunta cuál (`Clarification`) y no elige. Además faltan el medio y el importe, que se piden después.

> pagá las facturas vencidas de Tecnoparts por transferencia

Ve cómo se imputa el pago a las facturas vencidas del proveedor y la deuda que queda (`ConfirmationCard`). El importe supera el umbral, así que la pantalla pide la confirmación de un supervisor. Al confirmar, la transferencia queda pendiente de débito bancario.

> pagale 300 en efectivo a Papelera Central

Ve a qué factura se imputa (la que vence primero, que queda con saldo) y la deuda que queda (`ConfirmationCard`). No pide un supervisor porque está por debajo de los umbrales de pagos y de caja; al confirmar, el egreso queda también en la caja.

> pagale 150 en efectivo a Aurora

Con rol de operador, el servidor rechaza la operación y el agente lo informa (`ErrorNotice`): solo un supervisor o un gerente prepara pagos.

> cómo estamos con Logística Andina

Esta frase no la resuelve una regla del router sino el modelo, que la manda al área de pagos. Ve el estado de cuenta del proveedor (`DetailCard`).
