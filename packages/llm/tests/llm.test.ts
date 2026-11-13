import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmError,
  OpenAiCompatibleProvider,
  PRECIO_DESCONOCIDO,
  ProveedorConPresupuesto,
  ScriptedProvider,
  UsoLlm,
  llamada,
  precioDe,
  ultimoResultado,
  type LlmRequest,
} from '../src/index.js';

const req = (extra: Partial<LlmRequest> = {}): LlmRequest => ({ system: 'sys', messages: [{ role: 'user', text: 'hola' }], tools: [], toolMode: 'any', etiqueta: 'prueba', ...extra });

describe('ScriptedProvider', () => {
  it('reproduce el guion en orden y registra una copia de cada petición', async () => {
    const p = new ScriptedProvider([llamada('a', { x: 1 }), (r, i) => llamada('b', { eco: r.etiqueta, i })]);
    const peticion = req();
    expect((await p.generate(peticion)).toolCalls[0]?.name).toBe('a');
    peticion.system = 'mutado después';
    const segunda = await p.generate(req({ etiqueta: 'agente:x' }));
    expect(segunda.toolCalls[0]?.args).toEqual({ eco: 'agente:x', i: 1 });
    expect(p.llamadas[0]?.system).toBe('sys');
    expect(p.pendientes).toBe(0);
    expect(p.entradasSerializadas()).toContain('hola');
  });

  it('falla con un mensaje claro cuando se agota el guion', async () => {
    const p = new ScriptedProvider([]);
    await expect(p.generate(req({ etiqueta: 'router' }))).rejects.toThrow(/se agotó el guion.*router/);
  });

  it('ultimoResultado encuentra el resultado más reciente de una tool', () => {
    const r = req({ messages: [{ role: 'tool', results: [{ callId: '1', name: 'listar', result: { n: 1 } }] }, { role: 'tool', results: [{ callId: '2', name: 'listar', result: { n: 2 } }] }] });
    expect(ultimoResultado(r, 'listar')).toEqual({ n: 2 });
    expect(() => ultimoResultado(r, 'otra')).toThrow();
  });
});

describe('precios y presupuesto', () => {
  const tabla = { 'modelo-a': { entrada: 1, salida: 2 }, 'modelo-a-mini': { entrada: 0.1, salida: 0.2 } };

  it('resuelve el precio por nombre exacto, por el prefijo más largo y con un valor alto para modelos desconocidos', () => {
    expect(precioDe('modelo-a', tabla)).toEqual({ entrada: 1, salida: 2 });
    expect(precioDe('modelo-a-mini-2026', tabla)).toEqual({ entrada: 0.1, salida: 0.2 });
    expect(precioDe('otro', tabla)).toEqual(PRECIO_DESCONOCIDO);
  });

  it('corta con PRESUPUESTO_AGOTADO al alcanzar el tope y avisa desde el 90 %', () => {
    const uso = new UsoLlm({ limiteUsd: 1, precios: { m: { entrada: 1000, salida: 0 } } });
    uso.registrar('m', 900, 0); // 0,90 USD
    expect(uso.estado().en_aviso).toBe(true);
    expect(uso.estado().agotado).toBe(false);
    uso.registrar('m', 100, 0);
    expect(uso.estado().agotado).toBe(true);
    expect(() => uso.verificar()).toThrowError(expect.objectContaining({ codigo: 'PRESUPUESTO_AGOTADO' }));
  });

  describe('persistencia', () => {
    const dirs: string[] = [];
    afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

    it('guarda el gasto en un archivo y lo retoma en la próxima instancia', () => {
      const dir = mkdtempSync(join(tmpdir(), 'uso-'));
      dirs.push(dir);
      const archivo = join(dir, 'uso.json');
      new UsoLlm({ archivo, limiteUsd: 10, precios: { m: { entrada: 1, salida: 1 } } }).registrar('m', 1_000_000, 0);
      expect(JSON.parse(readFileSync(archivo, 'utf8')).total_usd).toBeCloseTo(1);
      const otra = new UsoLlm({ archivo, limiteUsd: 10 });
      expect(otra.estado().total_usd).toBeCloseTo(1);
    });
  });

  it('ProveedorConPresupuesto verifica antes y anota después', async () => {
    const interno = new ScriptedProvider([
      { toolCalls: [], uso: { modelo: 'm', tokensEntrada: 1_000_000, tokensSalida: 0, costoUsd: 0 } },
      { toolCalls: [] },
    ]);
    const uso = new UsoLlm({ limiteUsd: 1, precios: { m: { entrada: 1, salida: 1 } } });
    const p = new ProveedorConPresupuesto(interno, uso);
    await p.generate(req());
    expect(uso.estado().total_usd).toBeCloseTo(1);
    await expect(p.generate(req())).rejects.toBeInstanceOf(LlmError);
    expect(interno.llamadas).toHaveLength(1); // la segunda no llegó al modelo
  });
});

describe('OpenAiCompatibleProvider', () => {
  const respuesta = (cuerpo: unknown, status = 200): Response => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });

  it('arma la petición con tools, tool_choice y clave de entorno, y parsea llamadas y uso', async () => {
    let visto: { url: string; init: RequestInit } | undefined;
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://llm.invalid/v1',
      apiKey: 'clave-de-prueba',
      modelo: 'm1',
      precios: { m1: { entrada: 1, salida: 2 } },
      fetchImpl: (async (url: string, init: RequestInit) => {
        visto = { url, init };
        return respuesta({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'render_ui', arguments: '{"component":"DataTable"}' } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
      }) as unknown as typeof fetch,
    });
    const r = await p.generate(
      req({
        tools: [{ name: 'render_ui', description: 'd', parameters: { type: 'object' } }],
        messages: [
          { role: 'user', text: 'hola' },
          { role: 'assistant', toolCalls: [{ id: 'c0', name: 'listar', args: { a: 1 } }] },
          { role: 'tool', results: [{ callId: 'c0', name: 'listar', result: { ok: true } }] },
        ],
      }),
    );
    expect(visto?.url).toBe('https://llm.invalid/v1/chat/completions');
    expect((visto?.init.headers as Record<string, string>)['authorization']).toBe('Bearer clave-de-prueba');
    const cuerpo = JSON.parse(String(visto?.init.body));
    expect(cuerpo.tool_choice).toBe('required');
    expect(cuerpo.tools[0].function.name).toBe('render_ui');
    expect(cuerpo.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(cuerpo.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'c0' });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'render_ui', args: { component: 'DataTable' } }]);
    expect(r.uso?.costoUsd).toBeCloseTo(0.002);
  });

  it('traduce los fallos de red y de estado a LlmError LLM_NO_DISPONIBLE', async () => {
    const caido = new OpenAiCompatibleProvider({ baseUrl: 'https://llm.invalid', apiKey: 'k', modelo: 'm', fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch });
    await expect(caido.generate(req())).rejects.toMatchObject({ codigo: 'LLM_NO_DISPONIBLE' });
    const error500 = new OpenAiCompatibleProvider({ baseUrl: 'https://llm.invalid', apiKey: 'k', modelo: 'm', fetchImpl: (async () => respuesta({ error: 'x' }, 500)) as unknown as typeof fetch });
    await expect(error500.generate(req())).rejects.toMatchObject({ codigo: 'LLM_NO_DISPONIBLE' });
  });

  it('tolera argumentos que no son JSON válido', async () => {
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://llm.invalid',
      apiKey: 'k',
      modelo: 'm',
      fetchImpl: (async () => respuesta({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{roto' } }] } }] })) as unknown as typeof fetch,
    });
    expect((await p.generate(req())).toolCalls[0]?.args).toEqual({});
  });

  it('desdeEntorno nombra las variables que faltan y no trae ninguna clave por defecto', () => {
    expect(() => OpenAiCompatibleProvider.desdeEntorno({})).toThrowError(/LLM_BASE_URL, LLM_API_KEY, LLM_MODEL/);
    expect(OpenAiCompatibleProvider.desdeEntorno({ LLM_BASE_URL: 'https://x', LLM_API_KEY: 'k', LLM_MODEL: 'm' }).nombre).toBe('openai-compatible:m');
  });
});
