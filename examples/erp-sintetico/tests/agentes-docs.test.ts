import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTRO_AGENTES } from '../src/index.js';

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url));

describe('cada agente tiene su página en docs/agentes', () => {
  for (const agente of REGISTRO_AGENTES.todos()) {
    it(agente.nombre, () => {
      expect(existsSync(`${RAIZ}docs/agentes/${agente.nombre}.md`)).toBe(true);
    });
  }
});

describe('las frases de docs/agentes están en los evals', () => {
  const frasesDeEvals = new Set((JSON.parse(readFileSync(`${RAIZ}evals/frases.json`, 'utf8')) as { frases: { texto: string }[] }).frases.map((f) => f.texto));
  const paginas = readdirSync(`${RAIZ}docs/agentes`).filter((f) => f.endsWith('.md') && f !== 'README.md');

  it('hay una página por área', () => {
    expect(paginas.sort()).toEqual(REGISTRO_AGENTES.todos().map((a) => `${a.nombre}.md`).sort());
  });

  for (const pagina of paginas) {
    it(`${pagina}: cada frase citada (línea que empieza con "> ") es una frase de evals/frases.json`, () => {
      const citadas = readFileSync(`${RAIZ}docs/agentes/${pagina}`, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('> '))
        .map((l) => l.slice(2).trim());
      expect(citadas.length).toBeGreaterThanOrEqual(4);
      for (const frase of citadas) expect(frasesDeEvals.has(frase), `no está en evals: «${frase}»`).toBe(true);
    });
  }
});
