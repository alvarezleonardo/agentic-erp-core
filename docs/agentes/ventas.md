# Ventas

Ventas y análisis. El agente solo lee datos: no hay nada para confirmar.

Playbook: [`agentes/ventas/playbook.md`](../../examples/erp-sintetico/src/agentes/ventas/playbook.md). Código: [`agente.ts`](../../examples/erp-sintetico/src/agentes/ventas/agente.ts).

## Tools

Todas de lectura: `listar_metricas`, `consultar_metrica`, `serie_metrica`, `resumen_ventas`, `ranking_productos`, `detectar_anomalias`. No tiene `preparar_*` ni `confirmar_*`.

## Componentes

`KpiTiles`, `DataTable`, `TrendChart`, más los comunes (`Clarification`, `ErrorNotice`, `StatusToast`).

## Qué le podés pedir

Si la persona no dice el período, el agente usa el mes en curso hasta la fecha de referencia del negocio. Ninguna de estas frases pide confirmación.

> cuánto vendimos este mes

Ve indicadores con la comparación contra el período anterior (`KpiTiles`).

> cómo venimos de margen en febrero

Ve el margen bruto del mes comparado con el anterior (`KpiTiles`).

> los 5 artículos más vendidos del trimestre

Ve el ranking en una tabla (`DataTable`).

> ventas por canal esta semana

Ve el desglose por canal en una tabla (`DataTable`). Las semanas van de lunes a domingo.

> cómo evolucionaron las ventas de marzo

Ve la evolución en el tiempo (`TrendChart`).

> hay algo raro en lo que va del año

Ve los hallazgos de anomalías en una tabla, cada uno con el porqué de la regla (`DataTable`).
