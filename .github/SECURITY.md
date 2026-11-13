# Seguridad

## Versiones soportadas

El proyecto está en la serie 0.x y todavía no tiene una API estable. Solo se corrige la última versión publicada de 0.x (la rama `main`).

| Versión | Soportada |
|---|---|
| 0.x (última) | Sí |
| Anteriores | No |

## Reportar una vulnerabilidad

Usá el reporte privado de GitHub: en el repositorio, pestaña **Security**, botón **Report a vulnerability** ("Private vulnerability reporting"). No abras issues públicos ni publiques detalles hasta que haya una corrección.

## Qué está en alcance

- Orquestador y núcleo (`packages/core`): router, runner de agentes, `ProposalStore`, `Compositor`, `Confirmador`.
- Contrato MCP (`packages/mcp-contract`) y su verificación de conformidad, incluido el kit de servidor (token, idempotencia, PIN).
- GenUI (`contracts/genui`): componentes y validación de lo que llega a la pantalla.

Casos típicos: que el modelo logre confirmar una escritura, que filtre un token de confirmación o un PIN, que consiga fijar un monto, o que un `comando` del modo directo salte los permisos.

## Qué queda fuera de alcance

- El ERP sintético de `examples/erp-sintetico`: usa datos inventados y existe solo como ejemplo. Los errores de lógica de negocio ahí se reportan como issues comunes.
- El adaptador LLM de ejemplo (`packages/llm`) y el comportamiento del modelo o del proveedor que se conecte.
- Vulnerabilidades en dependencias de terceros sin un vector concreto en este código; reportalas al proyecto correspondiente.
- La configuración, el despliegue y el ERP real de quien integre el framework.
- Ataques que requieran acceso previo al servidor o a las credenciales de quien lo opera.
