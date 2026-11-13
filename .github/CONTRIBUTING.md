# Contribuir

Gracias por el interés. Este documento resume lo mínimo para proponer cambios.

## Puesta en marcha

Requiere Node 22 o superior (ver `.nvmrc`).

```bash
git clone https://github.com/alvarezleonardo/agentic-erp-core.git
cd agentic-erp-core
npm install
npm run check
```

Es un monorepo con npm workspaces: `packages/*` (core, llm, mcp-client, mcp-contract) y `examples/*` (erp-sintetico).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run typecheck` | Chequeo de tipos con `tsc --noEmit` |
| `npm test` | Tests con Vitest |
| `npm run eval` | Evals offline: 31 frases doradas con un LLM guionado, sin red ni secretos |
| `npm run check` | Los tres anteriores, en ese orden. Es lo que corre el CI |
| `npm run ejemplo:servidor` | Levanta el servidor MCP del ERP sintético |

Los evals no llaman a ningún modelo real, así que no hace falta ninguna clave para correr `npm run check`.

## Flujo de trabajo

- Todo cambio va por PR contra `main`; no se commitea directo a `main`.
- Un branch por tema, con prefijo `feat/`, `fix/`, `docs/` o `chore/` (por ejemplo `fix/token-en-trazas`).
- Un PR chico y atómico por tema.
- Commits en español, con estilo conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`.
- `npm run check` tiene que pasar antes de pedir revisión. Si cambia el comportamiento, agregá o ajustá tests y, si corresponde, evals.
- Si el cambio es visible para quien usa el framework, sumá una entrada en `CHANGELOG.md` bajo "Sin publicar".
- Si tocás el contrato MCP, actualizá `packages/mcp-contract/CONTRACT.md` y su JSON Schema.
- La documentación va en español, sin emojis.

## Principios no negociables

Un cambio que rompa alguno de estos no se acepta (ver [ADR-001](../docs/adr/ADR-001-principios.md)):

- El modelo nunca llama a `confirmar_*`: solo el `Confirmador`, ante un `ui.action` de la persona.
- El servidor pone los montos: el modelo no escribe importes ni los dice con cifras.
- Los tokens de confirmación y los PIN quedan fuera del modelo y de las trazas.

Para reportar una vulnerabilidad, seguí [SECURITY.md](SECURITY.md) en vez de abrir un issue.
