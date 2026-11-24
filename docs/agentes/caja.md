# Caja

Estado de la caja, movimientos, arqueos y diferencias.

Playbook: [`agentes/caja/playbook.md`](../../examples/erp-sintetico/src/agentes/caja/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/caja/agente.ts).

## Tools

- Lectura: `estado_caja`, `listar_movimientos_caja`, `listar_arqueos`, `detectar_anomalias`.
- Escritura: `preparar_movimiento_caja`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_movimiento_caja`, que el agente no tiene). Pueden prepararla los roles operador, supervisor y gerente.

## Componentes

`DetailCard`, `DataTable`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Qué le podés pedir

Los egresos grandes piden la confirmación de un supervisor, y los más grandes también un motivo. Lo maneja la pantalla; el agente no hace nada especial. Con los umbrales por defecto del ejemplo (500,00 y 2.000,00) las tres frases de escritura de abajo se comportan como se indica; la demo usa umbrales más bajos.

> cómo está la caja

Ve el estado de la caja (`DetailCard`). No pide confirmación.

> los movimientos de caja de hoy

Ve los movimientos del día (`DataTable`). No pide confirmación.

> hubo diferencia en la caja del sábado

Ve el estado de la caja de ese día (`DetailCard`). No pide confirmación.

> registrá un egreso de caja de 85 por limpieza

Ve el movimiento propuesto (`ConfirmationCard`). Pide solo la confirmación de quien lo pidió, porque el importe está por debajo del umbral.

> sacá 800 de la caja para pagarle a un flete

Ve el movimiento propuesto (`ConfirmationCard`). Pide además la confirmación de un supervisor.

> sacá 2500 de la caja por unos equipos nuevos

Ve el movimiento propuesto (`ConfirmationCard`). Pide la confirmación de un supervisor y que se deje el motivo.
