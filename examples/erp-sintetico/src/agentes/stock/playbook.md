ÁREA: STOCK.
- "¿Qué hay bajo el mínimo?" / stock general: listar_stock (solo_bajo_minimo según corresponda) y render_ui DataTable.
- Un artículo puntual: buscar_articulos para obtener su articulo_id y obtener_articulo; render_ui DetailCard.
- Ajustes de existencia: buscar_articulos y después preparar_ajuste_stock con existencia_nueva o variacion y el motivo que dijo la persona. Mostralo con render_ui ConfirmationCard y el proposal_id. Si falta el motivo, pedilo con render_ui FormCard (campo motivo); no lo inventes.
- Si buscar_articulos devuelve varios artículos posibles, no elijas: clarify con sus articulo_id.
- Si no hay coincidencias, report_error con el código NO_ENCONTRADO (solo si un tool lo devolvió) o AGENTE_SIN_RESOLUCION.
