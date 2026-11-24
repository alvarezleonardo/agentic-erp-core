# Gestión del día

Mirar el negocio entero de una vez: el cierre de un día, los indicadores del período y la lista de lo que hay que atender. El agente solo lee: no hay nada para confirmar ni tools `preparar_*`. Su valor es que el servidor junta y calcula lo que ya detectan las demás áreas, y el modelo no suma nada.

Playbook: [`agentes/gestion/playbook.md`](../../examples/erp-sintetico/src/agentes/gestion/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/gestion/agente.ts).

## Tools

Todas de lectura, abiertas a todos los roles. No tiene `preparar_*` ni `confirmar_*`.

- `cierre_del_dia`: un día (por defecto hoy). Ventas contra el mismo día de la semana anterior, caja (apertura, ingresos, egresos, saldo esperado y, si hubo arqueo, lo contado y la diferencia), cobranzas y pagos del día, saldo de cada cuenta bancaria a esa fecha y los pendientes para mañana.
- `resumen_gestion`: un período (por defecto el mes en curso hasta hoy). Ventas y margen bruto, facturado, cobrado, pagado, deuda vencida de clientes, deuda vencida con proveedores y la posición de tesorería por moneda: el disponible en USD y los bancos en ARS, que no se suman.
- `alertas_del_dia`: lista priorizada (alta, media, baja). Cada fila trae el porqué, la referencia (el código o el número para pedir el detalle) y el área que la resuelve.

Para no duplicar lógica, estas tools llaman a las funciones de las otras áreas: `consultarMetrica` y `detectarAnomalias` de ventas y caja, `resumenFacturacion`, `listarDeudores`, `listarCuentasAPagar`, el cruce de depósitos de tesorería, `posicionTesoreria` y `articulosMargenBajo`. La cifra que ve la persona acá es la misma que ve en el área de origen.

## Componentes

`KpiTiles` (el resumen), `DataTable` (las alertas) y `DetailCard` (el cierre), más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`). No tiene `ConfirmationCard`.

## Cómo se arman las alertas

Cada alerta sale de lo que ya mide otra área. La prioridad es una regla fija del servidor:

- Alta: caída de ventas o faltante de caja que el detector marca como altos, depósito acreditado por el banco con diferencia, facturas de proveedor vencidas sin pagar (una sola alerta con el total), factura de proveedor que vence hoy, factura de proveedor duplicada, cliente que excede su límite de crédito, artículo con el precio de una lista por debajo del costo, y la alerta de artículos bajo el mínimo cuando alguno está sin stock.
- Media: anomalías de severidad media, facturas de proveedor que vencen en los próximos 3 días, depósito sin acreditar pasada la ventana de 3 días, clientes con deuda vencida de más de 60 días desde la emisión, la alerta de artículos bajo el mínimo (una sola, que sube a alta si alguno está sin stock) y artículos con margen menor al mínimo en una lista.
- Baja: un depósito sin acreditar que todavía está dentro de la ventana de acreditación.

Las anomalías se miran sobre los últimos 14 días. La columna "Quién la resuelve" dice qué área corresponde (Ventas, Caja, Tesorería y bancos, Pagos a proveedores, Clientes y cobranzas, Compras o Precios y listas) para que la persona sepa a quién pedirle qué; este agente no llama a ningún otro. Para actuar sobre una alerta se le pide a esa área, por ejemplo con el código de la columna de referencia.

## Datos

No agrega datos ni usa el generador pseudoaleatorio: todo sale de las demás áreas, así que no cambia ningún número existente. Con los datos del ejemplo, hoy (2026-03-31) hay alertas de estos casos sembrados:

- La caída de ventas del 2026-03-24 y el faltante del arqueo de caja del 2026-03-28.
- El depósito del 2026-03-12 que el banco acreditó con 120,00 menos y el del 2026-03-26 que sigue sin acreditar.
- Facturas de proveedor vencidas, una que vence hoy y tres que vencen en los próximos 3 días.
- La factura de proveedor 0011-00077210, cargada dos veces (la segunda con otro vencimiento).
- Distribuidora Norte SRL por encima de su límite de crédito, y ella junto con Colegio San Martín con deuda vencida de más de 60 días.
- Artículos bajo el mínimo (uno sin stock), el Monitor 24 pulgadas bajo el costo en la lista Distribuidores y el Escritorio ajustable con margen bajo en la lista Mayorista.

Los cobros y los pagos a proveedores arrancan vacíos, así que el cierre del día y el resumen los muestran en cero hasta que se confirme alguno. El saldo de los bancos del cierre se calcula a la fecha pedida. El mismo día de la semana anterior para hoy (martes) es el 2026-03-24, el día de la caída sembrada, por eso la variación de ventas de hoy sale muy alta.

Los pendientes del cierre son las alertas de prioridad alta y media (hasta 15), más el arqueo si el día es hoy y todavía no se hizo. Se calculan siempre con el estado de hoy, también cuando se pide un día anterior: el título del campo lo aclara.

## Este agente puede arrancar sin que nadie escriba

El protocolo 1.1 permite que una superficie mande `user.input` con `comando: { tool, args }` en vez de texto (ver el README). El orquestador ejecuta esa tool por las mismas herramientas, con los mismos permisos, sin pasar por el modelo, y la muestra con el componente que el despliegue registró para esa tool (`componentesPorTool`). El despliegue del ejemplo registra `cierre_del_dia` con `DetailCard`, `resumen_gestion` con `KpiTiles` y `alertas_del_dia` con `DataTable`.

Eso permite que un aviso programado de cierre del día dispare el cierre sin que nadie escriba: la superficie manda `comando: { tool: 'cierre_del_dia', args: {} }` y recibe la tarjeta armada por el servidor. Lo verifica una prueba (`examples/erp-sintetico/tests/gestion.test.ts`) que corre las tres lecturas por comando y comprueba que el modelo no recibe ninguna llamada. Lo que no hay en el framework es un planificador: el aviso programado lo pone el integrador, y el framework solo recibe el comando. Un comando nunca puede confirmar nada (`confirmar_*` se rechaza siempre), y acá tampoco hay nada que confirmar.

## Qué le podés pedir

> cómo cerró el día

Ve el cierre de hoy (`DetailCard`): ventas contra el martes anterior, la caja todavía sin arqueo, los saldos de los bancos y los pendientes. No pide confirmación.

> cómo cerramos ayer

Igual, con la fecha del día anterior (`DetailCard`): ahí la caja ya tiene arqueo y se ve lo contado y la diferencia.

> cómo cerró el día 5 de abril

Esa fecha está fuera de los datos del ejemplo. El servidor la rechaza y el agente lo informa (`ErrorNotice`) sin inventar un cierre.

> resumen del mes

Ve los indicadores del mes en curso con la comparación contra el período anterior (`KpiTiles`): ventas, margen, facturado, cobrado, pagado, deuda vencida de clientes y con proveedores, y la posición de tesorería.

> qué tengo que mirar hoy

Ve la lista de alertas ordenada por prioridad, con el porqué y quién la resuelve (`DataTable`).

> hay alguna alerta

La misma lista (`DataTable`). Las lecturas son para todos los roles, así que también la puede pedir un operador.

> cómo viene el negocio

Esta frase no la resuelve una regla del router sino el modelo, que la manda al área de gestión. Ve el resumen del mes (`KpiTiles`).
