import { describe, expect, it } from 'vitest';
import { ARTICULO_BAJO_COSTO, ARTICULO_MARGEN_BAJO, ErpSintetico, HOY, LISTA_DISTRIBUIDORES, LISTA_MAYORISTA, LISTA_MINORISTA, REGISTRO_AGENTES, TOOLS, contextoDe, crearServidorMcp, generarDatos, parsearPorcentaje, type OpcionesErp } from '../src/index.js';

type Obj = Record<string, unknown>;
const gerente = contextoDe('gerente');
const supervisorCtx = contextoDe('supervisor');
const operador = contextoDe('operador');
const CLAVE_SUPERVISOR = '2468';
const autorizadores = { supervisor1: { pin: CLAVE_SUPERVISOR, rol: 'supervisor' } as NonNullable<OpcionesErp['autorizadores']>[string] };
const nuevoErp = (opciones: OpcionesErp = {}): ErpSintetico => new ErpSintetico({ autorizadores, ...opciones });
const autoriza = (motivo?: string) => ({ autorizacion: { usuario: 'supervisor1', pin: CLAVE_SUPERVISOR, ...(motivo ? { motivo } : {}) } });
const args = (p: { proposal_id: string; confirmation_token: string }, extra: Obj = {}, clave = 'idk_precios_0001'): Obj => ({ proposal_id: p.proposal_id, confirmation_token: p.confirmation_token, idempotency_key: clave, ...extra });
const cent = (d: unknown): number => Number(String((d as { monto: string }).monto).replace('.', ''));
const TECNOLOGIA = ['art_003', 'art_004', 'art_005', 'art_006', 'art_007'];

const precioDe = (erp: ErpSintetico, lista: string, articulo: string): number =>
  lista === LISTA_MINORISTA ? erp.datos.articulos.find((a) => a.id === articulo)!.precio : erp.datos.preciosLista.find((p) => p.lista_id === lista && p.articulo_id === articulo)!.precio;
const filaDe = (t: { filas: Obj[] }, articulo: string, lista?: string): Obj => t.filas.find((f) => f['articulo_id'] === articulo && (!lista || f['lista'] === lista))!;

describe('datos de precios y listas', () => {
  it('son deterministas, hay tres listas y un precio en Mayorista y Distribuidores por artículo', () => {
    const a = generarDatos();
    expect(a.listasPrecios).toEqual(generarDatos().listasPrecios);
    expect(a.preciosLista).toEqual(generarDatos().preciosLista);
    expect(a.cambiosPrecio).toEqual(generarDatos().cambiosPrecio);
    expect(a.listasPrecios.map((l) => [l.id, l.nombre])).toEqual([[LISTA_MINORISTA, 'Minorista'], [LISTA_MAYORISTA, 'Mayorista'], [LISTA_DISTRIBUIDORES, 'Distribuidores']]);
    expect(a.preciosLista).toHaveLength(a.articulos.length * 2);
  });

  it('Mayorista y Distribuidores derivan del precio Minorista, salvo las dos excepciones sembradas', () => {
    const d = generarDatos();
    const mouse = d.articulos.find((x) => x.id === 'art_005')!;
    expect(mouse.precio).toBe(2_900);
    expect(d.preciosLista.find((p) => p.lista_id === LISTA_MAYORISTA && p.articulo_id === 'art_005')!.precio).toBe(2_610);
    expect(d.preciosLista.find((p) => p.lista_id === LISTA_DISTRIBUIDORES && p.articulo_id === 'art_005')!.precio).toBe(2_380);
    expect(d.preciosLista.find((p) => p.lista_id === LISTA_DISTRIBUIDORES && p.articulo_id === ARTICULO_BAJO_COSTO)!.precio).toBe(11_900);
    expect(d.preciosLista.find((p) => p.lista_id === LISTA_MAYORISTA && p.articulo_id === ARTICULO_MARGEN_BAJO)!.precio).toBe(20_900);
  });

  it('el último cambio del historial de cada artículo y lista termina en el precio vigente, y los cambios son anteriores o iguales a hoy', () => {
    const erp = nuevoErp();
    expect(erp.datos.cambiosPrecio.length).toBeGreaterThan(0);
    const pares = new Set(erp.datos.cambiosPrecio.map((c) => `${c.lista_id}:${c.articulo_id}`));
    for (const par of pares) {
      const [lista, art] = par.split(':') as [string, string];
      const ultimo = erp.datos.cambiosPrecio.filter((c) => c.lista_id === lista && c.articulo_id === art).sort((x, y) => x.fecha.localeCompare(y.fecha) || x.id.localeCompare(y.id)).at(-1)!;
      expect(ultimo.precio_nuevo, par).toBe(precioDe(erp, lista, art));
    }
    for (const c of erp.datos.cambiosPrecio) expect(c.fecha <= HOY).toBe(true);
  });
});

describe('lecturas de precios', () => {
  it('listar_precios por lista trae precio, costo y margen calculado por el servidor', () => {
    const t = nuevoErp().listarPrecios({ lista: 'mayorista' });
    expect(t.filas).toHaveLength(12);
    const mouse = filaDe(t, 'art_005');
    expect(mouse).toMatchObject({ lista: 'Mayorista', margen_pct: '50.2', estado: 'ok' });
    expect(cent(mouse['precio'])).toBe(2_610);
    expect(cent(mouse['costo'])).toBe(1_300);
    expect(t.titulo).toContain('Mayorista');
    expect(t.columnas.map((c) => c.id)).toEqual(['articulo_id', 'nombre', 'categoria', 'lista', 'precio', 'costo', 'margen_pct', 'estado']);
  });

  it('filtra por categoría y por artículo, sin lista trae todas, y la lista se resuelve por código o nombre', () => {
    const erp = nuevoErp();
    expect(erp.listarPrecios({ lista: 'Lista Mayorista', categoria: 'tecnologia' }).filas).toHaveLength(5);
    const uno = erp.listarPrecios({ articulo_id: 'art_004' });
    expect(uno.filas.map((f) => f['lista'])).toEqual(['Minorista', 'Mayorista', 'Distribuidores']);
    expect(erp.listarPrecios({ lista: LISTA_DISTRIBUIDORES }).filas).toHaveLength(12);
    expect(() => erp.listarPrecios({ lista: 'vip' })).toThrow(/No existe la lista/);
    expect(() => erp.listarPrecios({ categoria: 'Jardín' })).toThrow(/categoría/);
    expect(() => erp.listarPrecios({ articulo_id: 'art_99' })).toThrow(/No existe el artículo/);
  });

  it('historial_precios del teclado mecánico: más reciente primero, con variación, quién y por qué', () => {
    const erp = nuevoErp();
    const t = erp.historialPrecios({ articulo_id: 'art_004' });
    expect(t.total_filas).toBe(3);
    expect(t.filas.map((f) => f['fecha'])).toEqual(['2025-12-02', '2025-12-02', '2025-10-06']);
    const minorista = t.filas.find((f) => f['lista'] === 'Minorista' && f['fecha'] === '2025-12-02')!;
    expect(cent(minorista['precio_anterior'])).toBe(8_500);
    expect(cent(minorista['precio_nuevo'])).toBe(8_900);
    expect(minorista).toMatchObject({ variacion_pct: '+4.7', usuario: 'gerente1', motivo: 'Ajuste de fin de año' });
    expect(erp.historialPrecios({ articulo_id: 'art_004', lista: 'Mayorista' }).filas).toHaveLength(1);
    expect(erp.historialPrecios({ articulo_id: 'art_001' }).filas).toHaveLength(0);
    expect(() => erp.historialPrecios({ articulo_id: 'art_99' })).toThrow(/No existe el artículo/);
  });

  it('articulos_margen_bajo encuentra exactamente los dos casos sembrados, del peor al mejor, y el mínimo es configurable', () => {
    const erp = nuevoErp();
    const t = erp.articulosMargenBajo({});
    expect(t.filas.map((f) => [f['articulo_id'], f['lista'], f['estado']])).toEqual([
      [ARTICULO_BAJO_COSTO, 'Distribuidores', 'bajo_costo'],
      [ARTICULO_MARGEN_BAJO, 'Mayorista', 'margen_bajo'],
    ]);
    expect(t.filas.map((f) => f['margen_pct'])).toEqual(['-4.2', '6.7']);
    expect(t.titulo).toContain('1 bajo el costo');
    expect(erp.articulosMargenBajo({ margen_minimo_pct: '5' }).filas).toHaveLength(1);
    expect(erp.articulosMargenBajo({ margen_minimo_pct: 40, lista: 'Minorista' }).filas.length).toBeGreaterThan(0);
    expect(nuevoErp({ umbralesPrecios: { margenMinimoPct: 5 } }).articulosMargenBajo({}).filas).toHaveLength(1);
    expect(erp.articulosMargenBajo({ lista: 'Minorista' }).filas).toHaveLength(0);
    expect(() => erp.articulosMargenBajo({ margen_minimo_pct: '150' })).toThrow(/entre 0 y 100/);
    expect(() => erp.articulosMargenBajo({ margen_minimo_pct: 'mucho' })).toThrow(/no es válido/);
  });

  it('parsearPorcentaje acepta coma, signo y símbolo, y rechaza lo demás', () => {
    expect(parsearPorcentaje('8')).toBe(800);
    expect(parsearPorcentaje('-12,5 %')).toBe(-1250);
    expect(parsearPorcentaje(+8)).toBe(800);
    for (const mal of ['', 'abc', '1.234', '8 por ciento']) expect(() => parsearPorcentaje(mal)).toThrow();
  });
});

describe('preparar cambio de precio', () => {
  it('porcentaje: sube 8 % la lista minorista de tecnología con redondeo a 5 centavos y muestra antes, después y margen', () => {
    const erp = nuevoErp();
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', categoria: 'Tecnología', modo: 'porcentaje', valor: '8' }, supervisorCtx);
    expect(p.titulo).toContain('Minorista');
    expect(p.lineas).toHaveLength(5);
    const nuevos = Object.fromEntries(p.lineas!.map((l, i) => [TECNOLOGIA[i]!, cent(l.precio_unitario)]));
    // 18900, 8900, 2900, 6500 y 5400 por 1,08, redondeados a 5 centavos.
    expect(nuevos).toEqual({ art_003: 20_410, art_004: 9_610, art_005: 3_130, art_006: 7_020, art_007: 5_830 });
    expect(p.lineas![2]!.descripcion).toContain('29.00 USD a 31.30 USD (+7.9 %), margen 55.2 % a 58.5 %');
    expect(p.step_up).toBeUndefined();
    expect(p.total).toBeUndefined();
    expect(p.advertencias).toContain('Los precios se redondean al múltiplo de 5 centavos más cercano.');
    expect(p.advertencias).toContain('Al confirmar rige el precio nuevo desde hoy: las ventas ya registradas no cambian.');
    // Preparar no cambia nada.
    expect(precioDe(erp, LISTA_MINORISTA, 'art_005')).toBe(2_900);
    expect(erp.datos.cambiosPrecio).toHaveLength(generarDatos().cambiosPrecio.length);
  });

  it('precio: el precio nuevo es el que dijo la persona, y el margen resultante se calcula en el servidor', () => {
    const erp = nuevoErp();
    const p = erp.prepararCambioPrecio({ lista: 'mayorista', articulo_ids: ['art_005'], modo: 'precio', valor: '25' }, gerente);
    expect(cent(p.lineas![0]!.precio_unitario)).toBe(2_500);
    expect(p.lineas![0]!.descripcion).toContain('26.10 USD a 25.00 USD (-4.2 %), margen 50.2 % a 48.0 %');
    expect(p.step_up).toBeUndefined();
    expect(p.advertencias?.some((x) => /redondea/.test(x))).toBe(false);
  });

  it('margen: alinea al margen pedido sobre el costo, redondeando hacia arriba para no quedar debajo', () => {
    const erp = nuevoErp();
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_003'], modo: 'margen', valor: '40' }, gerente);
    // Costo 124.00 / 0,60 = 206.666..., hacia arriba a 5 centavos: 206.70.
    expect(cent(p.lineas![0]!.precio_unitario)).toBe(20_670);
    expect(p.lineas![0]!.descripcion).toContain('margen 34.4 % a 40.0 %');
    expect(p.resumen).toContainEqual({ etiqueta: 'Cambio pedido', valor: 'Alinear al margen de 40.0 %' });
    expect(p.advertencias).toContain('Los precios se redondean hacia arriba a múltiplos de 5 centavos, para no quedar por debajo del margen pedido.');
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_003'], modo: 'margen', valor: '96' }, gerente)).toThrow(/entre 0 y 95/);
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_003'], modo: 'margen', valor: '-1' }, gerente)).toThrow(/entre 0 y 95/);
  });

  it('rechaza precios menores o iguales a cero, valores inválidos y selecciones inválidas', () => {
    const erp = nuevoErp();
    const base = { lista: 'Minorista', articulo_ids: ['art_005'] };
    for (const valor of ['0', '-5', 'abc', '']) expect(() => erp.prepararCambioPrecio({ ...base, modo: 'precio', valor }, gerente), `precio ${valor}`).toThrow(/importe/i);
    expect(() => erp.prepararCambioPrecio({ ...base, modo: 'porcentaje', valor: '-100' }, gerente)).toThrow(/cero o negativo/);
    expect(() => erp.prepararCambioPrecio({ ...base, modo: 'porcentaje', valor: '-150' }, gerente)).toThrow(/cero o negativo/);
    // Una baja que redondeada deja el precio en cero también se rechaza.
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_009'], modo: 'porcentaje', valor: '-99,9' }, gerente)).toThrow(/mayor que cero/);
    try {
      erp.prepararCambioPrecio({ ...base, modo: 'precio', valor: '0' }, gerente);
    } catch (e) {
      expect(e).toMatchObject({ codigo: 'PARAMETRO_INVALIDO' });
    }
    expect(() => erp.prepararCambioPrecio({ ...base, modo: 'raro', valor: '1' }, gerente)).toThrow(/modo/);
    expect(() => erp.prepararCambioPrecio({ ...base, modo: 'precio' }, gerente)).toThrow(/Falta el valor/);
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', modo: 'precio', valor: '10' }, gerente)).toThrow(/articulo_ids o categoria/);
    expect(() => erp.prepararCambioPrecio({ ...base, categoria: 'Tecnología', modo: 'precio', valor: '10' }, gerente)).toThrow(/no los dos/);
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005', 'art_005'], modo: 'precio', valor: '10' }, gerente)).toThrow(/repetidos/);
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_99'], modo: 'precio', valor: '10' }, gerente)).toThrow(/No existe el artículo/);
    expect(() => erp.prepararCambioPrecio({ lista: 'vip', articulo_ids: ['art_005'], modo: 'precio', valor: '10' }, gerente)).toThrow(/No existe la lista/);
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', categoria: 'Jardín', modo: 'precio', valor: '10' }, gerente)).toThrow(/categoría/);
    expect(() => erp.prepararCambioPrecio({ ...base, modo: 'precio', valor: '10', motivo: 'x' }, gerente)).toThrow(/motivo/);
  });

  it('si el precio ya es ese, no hay cambio; si solo algunos coinciden, se avisa', () => {
    const erp = nuevoErp();
    expect(() => erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '29' }, gerente)).toThrow(/ningún artículo cambia/);
    try {
      erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'porcentaje', valor: '0' }, gerente);
    } catch (e) {
      expect(e).toMatchObject({ codigo: 'SIN_CAMBIOS' });
    }
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005', 'art_004'], modo: 'precio', valor: '29' }, gerente);
    expect(p.lineas).toHaveLength(1);
    expect(p.advertencias?.some((x) => x.includes('ya tienen ese precio: Mouse inalámbrico'))).toBe(true);
  });

  it('solo supervisor y gerente preparan: operador y lectura reciben PERMISO_DENEGADO', () => {
    const erp = nuevoErp();
    const a = { lista: 'Mayorista', articulo_ids: ['art_005'], modo: 'precio', valor: '25' };
    for (const rol of ['operador', 'lectura']) expect(() => erp.prepararCambioPrecio(a, contextoDe(rol))).toThrow(/rol/i);
    try {
      erp.prepararCambioPrecio(a, operador);
    } catch (e) {
      expect(e).toMatchObject({ codigo: 'PERMISO_DENEGADO' });
    }
    for (const rol of ['supervisor', 'gerente']) expect(() => erp.prepararCambioPrecio(a, contextoDe(rol))).not.toThrow();
  });

  it('dejar un precio bajo el costo no se rechaza: se advierte y pide supervisor y motivo', () => {
    const erp = nuevoErp();
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '12' }, gerente);
    expect(p.step_up).toBe('supervisor_y_motivo');
    expect(p.requiere_step_up).toBe(true);
    expect(p.advertencias).toContain('Mouse inalámbrico queda por debajo del costo (12.00 USD con un costo de 13.00 USD).');
    expect(p.advertencias).toContain('Dejar un precio por debajo del costo necesita la confirmación de un supervisor y el motivo.');
    expect(p.lineas![0]!.descripcion).toContain('margen 55.2 % a -8.3 %');
    // Igual al costo no es "por debajo del costo": queda con margen cero, advertido por el margen mínimo, y la variación (-55 %) pide supervisor.
    const igual = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '13' }, gerente);
    expect(igual.step_up).toBe('supervisor');
    expect(igual.advertencias?.some((x) => x.includes('margen de 0.0 %'))).toBe(true);
  });

  it('un cambio de más del umbral de variación pide supervisor, hacia arriba o hacia abajo, y el umbral se configura', () => {
    const erp = nuevoErp();
    const cambio = (valor: string, e = erp) => e.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_001'], modo: 'porcentaje', valor }, gerente);
    expect(cambio('15').step_up).toBeUndefined();
    expect(cambio('-15').step_up).toBeUndefined();
    expect(cambio('16').step_up).toBe('supervisor');
    expect(cambio('-16').step_up).toBe('supervisor');
    expect(cambio('16').advertencias).toContain('Los cambios de más de 15.0 % en un artículo necesitan la confirmación de un supervisor.');
    expect(cambio('5', nuevoErp({ umbralesPrecios: { variacionPct: 4 } })).step_up).toBe('supervisor');
    expect(cambio('3', nuevoErp({ umbralesPrecios: { variacionPct: 4 } })).step_up).toBeUndefined();
  });

  it('un cambio masivo (más de 5 artículos) pide supervisor y el umbral se configura', () => {
    const erp = nuevoErp();
    expect(erp.prepararCambioPrecio({ lista: 'Mayorista', categoria: 'Tecnología', modo: 'porcentaje', valor: '2' }, gerente).step_up).toBeUndefined();
    const toda = erp.prepararCambioPrecio({ lista: 'Mayorista', articulo_ids: erp.datos.articulos.map((a) => a.id), modo: 'porcentaje', valor: '2' }, gerente);
    expect(toda.step_up).toBe('supervisor');
    expect(toda.advertencias).toContain('Los cambios de más de 5 artículos a la vez necesitan la confirmación de un supervisor.');
    expect(nuevoErp({ umbralesPrecios: { masivo: 2 } }).prepararCambioPrecio({ lista: 'Mayorista', articulo_ids: ['art_001', 'art_002', 'art_003'], modo: 'porcentaje', valor: '2' }, gerente).step_up).toBe('supervisor');
  });
});

describe('confirmar cambio de precio', () => {
  it('Minorista cambia el precio del artículo, deja el historial y no altera ventas ni métricas ya registradas', async () => {
    const erp = nuevoErp();
    const ventasAntes = JSON.stringify(erp.datos.ventas);
    const metricas = (e: ErpSintetico) => JSON.stringify(e.consultarMetrica(['ventas_total', 'margen_bruto_pct', 'unidades_vendidas'], '2026-01-01', HOY, true));
    const antes = metricas(erp);
    const resumenAntes = JSON.stringify(erp.resumenVentas('2026-01-01', HOY, 'categoria'));
    const cambios0 = erp.datos.cambiosPrecio.length;
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', categoria: 'Tecnología', modo: 'porcentaje', valor: '8', motivo: 'Aumento de costos' }, supervisorCtx);
    const salida = await erp.confirmar('cambio_precio', args(p), supervisorCtx);
    expect(salida).toMatchObject({ estado: 'confirmado', idempotente: false });
    expect(salida.mensaje).toContain('5 artículos');
    expect(precioDe(erp, LISTA_MINORISTA, 'art_005')).toBe(3_130);
    expect(precioDe(erp, LISTA_MINORISTA, 'art_003')).toBe(20_410);
    // Otras listas y otras categorías no se tocan.
    expect(precioDe(erp, LISTA_MAYORISTA, 'art_005')).toBe(2_610);
    expect(precioDe(erp, LISTA_MINORISTA, 'art_001')).toBe(14_900);
    expect(erp.datos.cambiosPrecio).toHaveLength(cambios0 + 5);
    expect(erp.datos.cambiosPrecio.at(-1)).toMatchObject({ lista_id: LISTA_MINORISTA, fecha: HOY, usuario: supervisorCtx.usuario, motivo: 'Aumento de costos' });
    expect(erp.historialPrecios({ articulo_id: 'art_005', lista: 'Minorista' }).filas[0]).toMatchObject({ variacion_pct: '+7.9', usuario: supervisorCtx.usuario });
    expect(erp.obtenerArticulo('art_005').campos).toContainEqual({ etiqueta: 'Precio de venta', valor: '31.30 USD' });
    // Las ventas históricas y sus métricas no cambian.
    expect(JSON.stringify(erp.datos.ventas)).toBe(ventasAntes);
    expect(metricas(erp)).toBe(antes);
    expect(JSON.stringify(erp.resumenVentas('2026-01-01', HOY, 'categoria'))).toBe(resumenAntes);
    expect(erp.auditoria.at(-1)).toMatchObject({ tool: 'confirmar_cambio_precio', usuario: supervisorCtx.usuario });
  });

  it('Mayorista cambia solo el precio de esa lista', async () => {
    const erp = nuevoErp();
    const p = erp.prepararCambioPrecio({ lista: 'Mayorista', articulo_ids: ['art_005'], modo: 'precio', valor: '25' }, gerente);
    const salida = await erp.confirmar('cambio_precio', args(p), gerente);
    expect(salida.mensaje).toContain('Mayorista: 1 artículo.');
    expect(precioDe(erp, LISTA_MAYORISTA, 'art_005')).toBe(2_500);
    expect(precioDe(erp, LISTA_MINORISTA, 'art_005')).toBe(2_900);
    expect(precioDe(erp, LISTA_DISTRIBUIDORES, 'art_005')).toBe(2_380);
    expect(erp.datos.cambiosPrecio.at(-1)).toMatchObject({ lista_id: LISTA_MAYORISTA, precio_anterior: 2_610, precio_nuevo: 2_500, motivo: 'Sin motivo indicado' });
  });

  it('repetir la clave no duplica el cambio, y una propuesta confirmada no se confirma de nuevo', async () => {
    const erp = nuevoErp();
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '30' }, gerente);
    const primera = await erp.confirmar('cambio_precio', args(p), gerente);
    const n = erp.datos.cambiosPrecio.length;
    const repetida = await erp.confirmar('cambio_precio', args(p), gerente);
    expect(repetida).toMatchObject({ idempotente: true, resultado: primera.resultado });
    expect(erp.datos.cambiosPrecio).toHaveLength(n);
    await expect(erp.confirmar('cambio_precio', args(p, {}, 'idk_precios_otra'), gerente)).rejects.toMatchObject({ codigo: 'PROPUESTA_YA_CONFIRMADA' });
    await expect(erp.confirmar('cambio_precio', { ...args(p), confirmation_token: 'token-que-no-es-el-de-la-propuesta' }, gerente)).rejects.toMatchObject({ codigo: 'TOKEN_INVALIDO' });
  });

  it('si el precio cambió entre preparar y confirmar, rechaza y no registra nada', async () => {
    const erp = nuevoErp();
    const uno = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '30' }, gerente);
    const dos = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '31' }, gerente);
    await erp.confirmar('cambio_precio', args(uno, {}, 'idk_pr_uno'), gerente);
    const n = erp.datos.cambiosPrecio.length;
    await expect(erp.confirmar('cambio_precio', args(dos, {}, 'idk_pr_dos'), gerente)).rejects.toMatchObject({ codigo: 'PRECIO_CAMBIADO' });
    expect(erp.datos.cambiosPrecio).toHaveLength(n);
    expect(precioDe(erp, LISTA_MINORISTA, 'art_005')).toBe(3_000);
  });

  it('un precio bajo el costo exige supervisor y motivo al confirmar, y nadie se autoriza a sí mismo', async () => {
    const erp = nuevoErp();
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '12' }, gerente);
    await expect(erp.confirmar('cambio_precio', args(p), gerente)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    await expect(erp.confirmar('cambio_precio', args(p, { autorizacion: { usuario: 'supervisor1', pin: 'mal' } }), gerente)).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
    await expect(erp.confirmar('cambio_precio', args(p, autoriza()), gerente)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    expect(precioDe(erp, LISTA_MINORISTA, 'art_005')).toBe(2_900);
    const ok = await erp.confirmar('cambio_precio', args(p, autoriza('Liquidación de fin de temporada')), gerente);
    expect(ok.estado).toBe('confirmado');
    expect(precioDe(erp, LISTA_MINORISTA, 'art_005')).toBe(1_200);
    expect(erp.datos.cambiosPrecio.at(-1)).toMatchObject({ motivo: 'Liquidación de fin de temporada' });
    expect(erp.auditoria.at(-1)).toMatchObject({ tool: 'confirmar_cambio_precio', autorizo: 'supervisor1', motivo: 'Liquidación de fin de temporada' });
    // El historial de esa lista ahora muestra el artículo en margen negativo.
    expect(erp.articulosMargenBajo({ lista: 'Minorista' }).filas.map((f) => f['articulo_id'])).toEqual(['art_005']);

    const propio = nuevoErp();
    const q = propio.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '12' }, contextoDe('supervisor', 'supervisor1'));
    await expect(propio.confirmar('cambio_precio', args(q, autoriza('Liquidación')), contextoDe('supervisor', 'supervisor1'))).rejects.toMatchObject({ codigo: 'AUTORIZACION_INVALIDA' });
  });

  it('una variación grande o un cambio masivo exigen a un supervisor', async () => {
    const erp = nuevoErp();
    const grande = erp.prepararCambioPrecio({ lista: 'Mayorista', articulo_ids: ['art_001'], modo: 'porcentaje', valor: '20' }, gerente);
    expect(grande.step_up).toBe('supervisor');
    await expect(erp.confirmar('cambio_precio', args(grande), gerente)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
    await expect(erp.confirmar('cambio_precio', args(grande, autoriza()), gerente)).resolves.toMatchObject({ estado: 'confirmado' });
    const masivo = erp.prepararCambioPrecio({ lista: 'Mayorista', articulo_ids: erp.datos.articulos.map((a) => a.id), modo: 'porcentaje', valor: '1' }, gerente);
    expect(masivo.step_up).toBe('supervisor');
    await expect(erp.confirmar('cambio_precio', args(masivo, {}, 'idk_precios_masivo'), gerente)).rejects.toMatchObject({ codigo: 'STEP_UP_REQUERIDO' });
  });

  it('una propuesta de otro tipo no se confirma como cambio de precio, ni un operador confirma', async () => {
    const erp = nuevoErp();
    const mov = erp.prepararMovimientoCaja({ tipo: 'egreso', concepto: 'Limpieza', importe: '10' }, gerente);
    await expect(erp.confirmar('cambio_precio', args(mov), gerente)).rejects.toMatchObject({ codigo: 'PROPUESTA_NO_ENCONTRADA' });
    const p = erp.prepararCambioPrecio({ lista: 'Minorista', articulo_ids: ['art_005'], modo: 'precio', valor: '30' }, gerente);
    await expect(erp.confirmar('cambio_precio', args(p), operador)).rejects.toMatchObject({ codigo: 'PERMISO_DENEGADO' });
    await expect(erp.confirmar('cambio_precio', args(p), contextoDe('gerente', 'otro_gerente'))).rejects.toMatchObject({ codigo: 'PERMISO_DENEGADO' });
  });
});

describe('por el servidor MCP y el agente', () => {
  it('el catálogo expone las lecturas y el par preparar/confirmar, valida el esquema y devuelve los errores del contrato', async () => {
    const { servidor } = crearServidorMcp();
    const { ClienteMcp } = await import('@agentic-erp/mcp-client');
    const c = await ClienteMcp.enMemoria(servidor);
    try {
      const nombres = (await c.listarTools()).map((t) => t.nombre);
      expect(nombres).toEqual(expect.arrayContaining(['listar_precios', 'historial_precios', 'articulos_margen_bajo', 'preparar_cambio_precio', 'confirmar_cambio_precio']));
      const lista = await c.llamar('listar_precios', { lista: 'Mayorista' }, operador);
      expect(lista.ok).toBe(true);
      expect((lista.datos['filas'] as unknown[]).length).toBe(12);
      const bajo = await c.llamar('articulos_margen_bajo', {}, operador);
      expect((bajo.datos['filas'] as unknown[]).length).toBe(2);
      const sinValor = await c.llamar('preparar_cambio_precio', { lista: 'Mayorista', modo: 'precio', articulo_ids: ['art_005'] }, gerente);
      expect(sinValor.datos['codigo']).toBe('PARAMETRO_INVALIDO');
      const ok = await c.llamar('preparar_cambio_precio', { lista: 'Mayorista', modo: 'precio', valor: '25', articulo_ids: ['art_005'] }, gerente);
      expect(ok.ok).toBe(true);
      expect(ok.datos['proposal_id']).toBeTruthy();
      const prohibido = await c.llamar('preparar_cambio_precio', { lista: 'Mayorista', modo: 'precio', valor: '25', articulo_ids: ['art_005'] }, operador);
      expect(prohibido.datos['codigo']).toBe('PERMISO_DENEGADO');
      const cero = await c.llamar('preparar_cambio_precio', { lista: 'Mayorista', modo: 'precio', valor: '0', articulo_ids: ['art_005'] }, gerente);
      expect(cero.datos['codigo']).toBe('PARAMETRO_INVALIDO');
      const malModo = await c.llamar('preparar_cambio_precio', { lista: 'Mayorista', modo: 'descuento', valor: '5', articulo_ids: ['art_005'] }, gerente);
      expect(malModo.datos['codigo']).toBe('PARAMETRO_INVALIDO');
    } finally {
      await c.cerrar();
    }
  });

  it('el agente de precios usa tools que existen, no tiene ninguna confirmar_* y no pasa de 15', () => {
    const agente = REGISTRO_AGENTES.todos().find((a) => a.nombre === 'precios')!;
    const existentes = new Set(TOOLS.map((t) => t.nombre));
    for (const t of agente.tools) expect(existentes.has(t), t).toBe(true);
    expect(agente.tools).toContain('buscar_articulos');
    expect(agente.tools.some((t) => t.startsWith('confirmar_'))).toBe(false);
    expect(agente.tools.length).toBeLessThanOrEqual(15);
  });
});
