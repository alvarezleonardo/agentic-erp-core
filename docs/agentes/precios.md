# Precios y listas

Las listas de precios de los artículos (Minorista, Mayorista y Distribuidores), el margen de cada precio sobre el costo, el historial de cambios y el cambio de precios.

Playbook: [`agentes/precios/playbook.md`](../../examples/erp-sintetico/src/agentes/precios/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/precios/agente.ts).

## Tools

- Lectura: `listar_precios` (precios vigentes por lista, categoría o artículo, con el costo y el margen % que calcula el servidor), `historial_precios` (cambios de precio de un artículo: antes, después, variación, quién y por qué) y `articulos_margen_bajo` (artículos por debajo de un margen mínimo, incluidos los que están bajo el costo). Para encontrar el artículo, el agente usa `buscar_articulos`, la misma tool del área de stock.
- Escritura: `preparar_cambio_precio`. Solo arma la propuesta; la confirma la persona desde la pantalla (`confirmar_cambio_precio`, que el agente no tiene). Pueden prepararla solo los roles supervisor y gerente; las lecturas son para todos.

## Componentes

`DataTable`, `DetailCard`, `ConfirmationCard`, `FormCard`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Datos

Esta área suma las listas (`ListaPrecios`), los precios de las listas Mayorista y Distribuidores (`PrecioLista`) y el historial (`CambioPrecio`). El precio de la lista Minorista es el precio del propio artículo, así que hay una sola fuente. No usa el generador pseudoaleatorio: todo sale de los artículos y no altera ni un número de los datos de las otras áreas. Casos sembrados:

- Mayorista es el 90 % del precio Minorista y Distribuidores el 82 %, redondeados a múltiplos de 5 centavos.
- Dos excepciones para que haya algo que detectar: el Monitor 24 pulgadas en Distribuidores está por debajo del costo (119,00 con un costo de 124,00) y el Escritorio ajustable en Mayorista tiene un margen de 6,7 % (209,00 con un costo de 195,00).
- Historial: unos pocos cambios de 2025, anteriores a los datos de ventas, en el teclado mecánico y el mouse inalámbrico, y dos de 2026 que explican las excepciones. El último cambio de cada artículo y lista siempre termina en el precio vigente.

Las ventas del ejemplo ya están generadas y guardan su importe y su costo. Un cambio de precio rige desde que se confirma y no reescribe las ventas ya registradas ni sus métricas (margen bruto incluido).

## Cómo calcula

- **Margen.** Es (precio menos costo) sobre el precio, en porcentaje con un decimal. Lo calcula el servidor en cada tabla y en cada propuesta.
- **Precio nuevo.** El modelo no calcula nada. El servidor admite tres formas: un precio nuevo (se usa tal cual lo dijo la persona), un porcentaje (el precio actual por 1 más el porcentaje, redondeado al múltiplo de 5 centavos más cercano; las mitades suben) y alinear al margen (el precio que deja ese margen sobre el costo, redondeado hacia arriba a 5 centavos para no quedar por debajo del margen pedido). El margen a alinear va de 0 a 95 %.
- **Qué rechaza.** Precios menores o iguales a cero (también una baja que los deje en cero tras el redondeo), valores que no son números, listas, categorías o artículos que no existen, artículos repetidos y un cambio que no modifica ningún precio. Si algunos artículos ya tienen el precio pedido, no cambian y se avisa.
- **Qué advierte, sin rechazar.** Un artículo que queda por debajo del costo, o con un margen menor al mínimo de 15 %. La propuesta muestra para cada artículo el precio antes y después, la variación, el margen antes y después y el costo.
- **Al confirmar.** Vuelve a verificar que cada precio siga siendo el que había al preparar: si alguien lo cambió en el medio, rechaza y hay que pedirlo de nuevo. Registra un cambio de precio por artículo con la fecha de hoy, quién lo hizo y el motivo (el que dio la persona; si no hay, «Sin motivo indicado»). Repetir la clave de idempotencia no duplica nada.

## Cuándo pide un supervisor

- Un cambio de más de 15 % en algún artículo, hacia arriba o hacia abajo, o un cambio de más de 5 artículos a la vez, pide la confirmación de un supervisor.
- Dejar un precio por debajo del costo pide la confirmación de un supervisor y el motivo.

Los umbrales se configuran al crear el ERP (`umbralesPrecios`: `variacionPct`, `masivo` y `margenMinimoPct`). Quien confirma tiene que ser otra persona con rol de supervisor o gerente: nadie se autoriza a sí mismo.

## Qué le podés pedir

> la lista mayorista de tecnología

Ve los precios de la lista Mayorista de los cinco artículos de tecnología, con costo y margen (`DataTable`).

> qué artículos tienen margen bajo

Ve los artículos y listas con un margen menor al mínimo, del peor al mejor (`DataTable`): el Monitor en Distribuidores, bajo el costo, y el Escritorio ajustable en Mayorista. El título trae cuántos hay y cuántos están bajo el costo.

> cómo cambió el precio del teclado mecánico

Primero busca el artículo y después trae su historial, del cambio más reciente al más viejo (`DataTable`). No pide confirmación.

> subí 8 % la lista minorista de tecnología

Ve cada artículo con su precio antes y después, el margen que queda y las advertencias de redondeo (`ConfirmationCard`). Son cinco artículos y ninguno cambia más de 15 %, así que alcanza con confirmar; al hacerlo, quedan el precio nuevo y un registro por artículo en el historial. Lo prepara un supervisor o un gerente.

> poné el mouse inalámbrico a 25 en la lista mayorista

Si lo pide un operador, el servidor rechaza la operación porque ese rol no puede cambiar precios, y el agente lo informa (`ErrorNotice`). Un supervisor o un gerente vería la propuesta con el precio y el margen antes y después.

> subí 5 % el escritorio en la lista minorista

La búsqueda de «escritorio» encuentra más de un artículo (el escritorio ajustable y la lámpara de escritorio), así que el agente pregunta cuál (`Clarification`) y no elige.

> a cuánto sale cada cosa para los revendedores

Esta frase no la resuelve una regla del router sino el modelo, que la manda al área de precios. Ve la lista Distribuidores con sus precios, costos y márgenes (`DataTable`).
