import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAiCompatibleProvider, ProveedorConPresupuesto, UsoLlm, type LlmProvider } from '@agentic-erp/llm';
import { cargarFrases, correrFrase, desglosar, DIR_EVALS, generarReporte, MedidorUso, textoCosto, type ResultadoFrase } from './lib.js';

/**
 * npm run eval                       trayectorias doradas con ScriptedProvider (gratis, determinista)
 * npm run eval -- --filtro=ven,sto-03   solo esas frases (id o prefijo de área)
 * npm run eval -- --proveedor=openai    contra un modelo real (variables LLM_* del entorno; respeta LLM_LIMITE_USD)
 */
const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main(): Promise<void> {
  const filtro = arg('filtro')?.split(',');
  const frases = cargarFrases().filter((f) => !filtro || filtro.some((x) => f.id === x || f.id.startsWith(`${x}-`)));
  const real = arg('proveedor') === 'openai';
  let llm: LlmProvider | undefined;
  let medidor: MedidorUso | undefined;
  if (real) {
    medidor = new MedidorUso(new ProveedorConPresupuesto(OpenAiCompatibleProvider.desdeEntorno(), new UsoLlm({ archivo: '.uso-llm.json' })));
    llm = medidor;
  }

  const resultados: ResultadoFrase[] = [];
  for (const f of frases) {
    const r = await correrFrase(f, llm);
    resultados.push(r);
    console.log(`${r.ok ? 'ok   ' : 'FALLA'} ${r.id.padEnd(8)} ${r.texto}${r.ok ? '' : `\n         ${r.fallas.join('\n         ')}`}`);
  }
  const aciertos = resultados.filter((r) => r.ok).length;
  console.log(`\n${aciertos}/${resultados.length} frases correctas (${((aciertos / Math.max(1, resultados.length)) * 100).toFixed(1)} %).`);

  const d = desglosar(resultados);
  console.log(`Router ${d.router}/${d.total}, plan ${d.plan}/${d.total}, tools ${d.tools}/${d.total}, componente ${d.componente}/${d.total}, costo ${textoCosto(medidor?.resumen())}.`);

  const dir = join(DIR_EVALS, 'reportes');
  mkdirSync(dir, { recursive: true });
  const uso = medidor?.resumen();
  const proveedor = real ? (llm?.nombre ?? 'openai') : 'scripted';
  const meta = { proveedor, modelo: real ? ([...(medidor?.modelos ?? [])].join(', ') || process.env['LLM_MODEL'] || proveedor) : proveedor, fecha: new Date().toISOString().slice(0, 10), ...(uso ? { uso } : {}) };
  writeFileSync(join(dir, 'ultimo.md'), generarReporte(resultados, meta));
  writeFileSync(join(dir, 'ultimo.json'), `${JSON.stringify({ ...meta, desglose: d, resultados }, null, 2)}\n`);
  console.log(`Reporte: evals/reportes/ultimo.md`);
  if (!real && aciertos !== resultados.length) process.exitCode = 1;
}

await main();
