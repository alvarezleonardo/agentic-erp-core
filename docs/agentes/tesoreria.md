# Tesorería y bancos

Las cuentas bancarias propias, su extracto, la conciliación de los depósitos de caja y la posición de tesorería.

Playbook: [`agentes/tesoreria/playbook.md`](../../examples/erp-sintetico/src/agentes/tesoreria/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/tesoreria/agente.ts).

## Tools

- Lectura: `listar_cuentas_bancarias` (saldo de cada cuenta en su moneda y los códigos `cuenta_id`), `listar_movimientos_bancarios` (extracto filtrado por cuenta, período y tipo), `conciliar_depositos` (cruza los egresos «Depósito bancario» de la caja con los créditos del banco) y `posicion_tesoreria` (caja, bancos, pagos pendientes de débito y vencimientos a proveedores de los próximos 7 días).
- Escritura: `preparar_transferencia_interna`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_transferencia_interna`, que el agente no tiene). Pueden prepararla los roles operador, supervisor y gerente.

## Componentes

`DataTable`, `KpiTiles`, `DetailCard`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Datos

Esta área suma tres cuentas (`CuentaBancaria`), el extracto (`MovimientoBancario`) y la transferencia interna (`TransferenciaInterna`). Como en facturación y pagos, el saldo no se guarda: es el saldo inicial al 01/01/2026 más los créditos menos los débitos. Los movimientos nacen de datos que ya existen en el ERP y se generan con una semilla propia, así que no alteran los datos de las otras áreas. Casos sembrados:

- Tres cuentas: «Banco Nación CC 1234» y «Banco Galicia CA USD 5678», en USD, y «Banco Santander CC ARS 9012», en ARS. Entre las dos primeras una transferencia es válida; con la tercera se rechaza por monedas distintas.
- Un crédito por cada egreso «Depósito bancario» de la caja, en el Nación, por el mismo importe, de 0 a 2 días después (nunca después de hoy).
- Un depósito acreditado por menos: el del 12/03/2026 entró al banco por 120,00 menos que lo que salió de la caja.
- Un depósito sin acreditar: el del 26/03/2026 no figura en el extracto.
- Débitos por los pagos a proveedores que las facturas ya traen hechos, acreditaciones de transferencias de clientes en cuenta corriente, y una comisión de mantenimiento por cuenta y mes más un impuesto sobre los débitos del mes en las cuentas en USD.

Los cobros y los pagos que se registren con el ERP después no generan movimientos bancarios: una transferencia a un proveedor queda `pendiente_debito` y se suma a la posición como tal, pero este ejemplo no escribe el débito en el extracto.

## Cómo calcula

- **Conciliación.** Un crédito del banco corresponde a un depósito de caja si cae entre el día del egreso y 3 días después. Primero se emparejan los de igual importe; con lo que sobra, un depósito sin pareja exacta toma un crédito de otro importe de su ventana, y eso es una diferencia (importe del banco menos importe de caja). Lo que no encuentra crédito queda pendiente. El cruce se hace sobre todos los depósitos y se filtra por período después, así que el resultado de un día no cambia según el rango que se pida. Por defecto la tabla trae solo lo que no cierra, y los totales van en el título.
- **Posición.** Caja es el saldo esperado de hoy. Bancos se suma por moneda: los USD no se mezclan con los ARS. Disponible en USD es caja más bancos en USD menos los pagos pendientes de débito, y se muestra también después de restar lo que vence a proveedores en los próximos 7 días. Todo lo calcula el servidor.
- **Transferencia interna.** El servidor rechaza cuentas de monedas distintas (este ejemplo no hace cambio de moneda), la misma cuenta de los dos lados, importes no válidos y un importe mayor al saldo de la cuenta de origen. Calcula los saldos que quedan. Al confirmar vuelve a verificar el saldo contra el estado real y deja dos movimientos, un débito en el origen y un crédito en el destino, con la fecha de hoy. No toca la caja.

## Cuándo pide un supervisor

Las transferencias internas de 5.000,00 o más piden la confirmación de un supervisor. El umbral se configura al crear el ERP (`umbralTransferenciaInterna`). Quien confirma tiene que ser otra persona con rol de supervisor o gerente: nadie se autoriza a sí mismo.

## Qué le podés pedir

> cuánta plata hay en las cuentas

Esta frase no la resuelve una regla del router sino el modelo, que la manda al área de tesorería. Ve las cuentas con su saldo (`DataTable`); el título trae el total por moneda.

> los movimientos del Nación de marzo

Primero busca el código de la cuenta y después trae el extracto de marzo (`DataTable`), con créditos positivos y débitos negativos. No pide confirmación.

> conciliá los depósitos de caja de marzo

Ve solo los depósitos que no cierran (`DataTable`): el acreditado por menos y el que todavía no figura en el banco. El título trae cuántos concilian y los totales.

> cuál es la posición de tesorería

Ve la caja, los bancos por moneda, lo pendiente de débito y los vencimientos de los próximos 7 días (`KpiTiles`). No pide confirmación.

> pasá 2000 del Nación al Galicia

Ve los saldos de las dos cuentas antes y después (`ConfirmationCard`). Las dos son en USD y el importe está bajo el umbral, así que alcanza con confirmar; al hacerlo quedan un débito y un crédito en el extracto.

> pasá 500 del Nación al Santander

Una cuenta es en USD y la otra en ARS: el servidor rechaza la operación y el agente lo informa (`ErrorNotice`). No se hace cambio de moneda.

> transferí del Galicia al Nación

Falta el importe, así que el agente lo pide con un formulario (`FormCard`) y no lo inventa.
