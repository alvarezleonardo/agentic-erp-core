import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTRO_AGENTES, leerPlaybook, toolsMcp } from '../src/index.js';

const playbookDe = (nombre: string): string => fileURLToPath(new URL(`../src/agentes/${nombre}/playbook.md`, import.meta.url));
const TOOLS_DEL_SERVIDOR = new Set(toolsMcp().map((t) => t.nombre));

describe('un agente por carpeta', () => {
  for (const agente of REGISTRO_AGENTES.todos()) {
    describe(agente.nombre, () => {
      it('tiene su playbook.md con contenido y es el que se le manda al modelo', () => {
        const ruta = playbookDe(agente.nombre);
        expect(existsSync(ruta)).toBe(true);
        const texto = readFileSync(ruta, 'utf8');
        expect(texto.trim().length).toBeGreaterThan(0);
        expect(agente.systemPrompt.endsWith(`\n\n${texto.replace(/\n$/, '')}`)).toBe(true);
      });

      it('el playbook solo nombra tools que el agente tiene', () => {
        const mencionadas = new Set((readFileSync(playbookDe(agente.nombre), 'utf8').match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).filter((m) => TOOLS_DEL_SERVIDOR.has(m)));
        expect(mencionadas.size).toBeGreaterThan(0);
        for (const t of mencionadas) expect(agente.tools, `${agente.nombre} nombra ${t} en el playbook`).toContain(t);
      });
    });
  }

  it('leerPlaybook quita solo el salto de línea final', () => {
    expect(leerPlaybook(new URL('../src/agentes/caja/agente.ts', import.meta.url).href).endsWith('\n')).toBe(false);
  });
});
