import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ContextoSesion, Obj, ToolMcp } from '@agentic-erp/mcp-contract';
import { ErpSintetico, ErrorErp, type OpcionesErp } from './erp.js';

const CONTEXTO = {
  type: 'object',
  required: ['tenant', 'usuario', 'rol'],
  additionalProperties: false,
  properties: {
    tenant: { type: 'string', minLength: 1 },
    usuario: { type: 'string', minLength: 1 },
    rol: { type: 'string', minLength: 1 },
    sucursal: { type: 'string' },
    origen: { enum: ['humano', 'agente'] },
  },
} as const;

const FECHA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha AAAA-MM-DD.' } as const;

const entrada = (props: Obj, required: string[] = []): Obj => ({ type: 'object', properties: { contexto: CONTEXTO, ...props }, required: ['contexto', ...required], additionalProperties: false });

interface DefTool {
  nombre: string;
  descripcion: string;
  esquema: Obj;
  manejar: (a: Obj, ctx: ContextoSesion, erp: ErpSintetico) => Obj | Promise<Obj>;
}

const confirmarEsquema = (): Obj =>
  entrada(
    {
      proposal_id: { type: 'string', description: 'Id de la propuesta a confirmar.' },
      confirmation_token: { type: 'string', minLength: 16 },
      idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
      autorizacion: {
        type: 'object',
        additionalProperties: false,
        description: 'Step-up: usuario y PIN de un supervisor y/o el motivo, según lo que pida la propuesta.',
        properties: { usuario: { type: 'string' }, pin: { type: 'string' }, motivo: { type: 'string', maxLength: 200 } },
      },
    },
    ['proposal_id', 'confirmation_token', 'idempotency_key'],
  );

/** El catálogo de tools del ERP sintético. Cumple el contrato de @agentic-erp/mcp-contract (se verifica en las pruebas). */
export const TOOLS: DefTool[] = [
  // ---- contrato: métricas, series, anomalías, eventos
  { nombre: 'listar_metricas', descripcion: 'Lista las métricas de negocio disponibles (ventas, unidades, margen, compras, faltante de caja) con su definición.', esquema: entrada({}), manejar: (_a, _c, erp) => erp.listarMetricas() },
  {
    nombre: 'consultar_metrica',
    descripcion: 'Calcula una o más métricas de negocio para un período, con la comparación contra el período anterior de igual duración. Devuelve indicadores listos para mostrar.',
    esquema: entrada({ metricas: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Ids de listar_metricas.' }, desde: FECHA, hasta: FECHA, comparar_con_anterior: { type: 'boolean' } }, ['metricas', 'desde', 'hasta']),
    manejar: (a, _c, erp) => ({ ...erp.consultarMetrica(a['metricas'], a['desde'], a['hasta'], a['comparar_con_anterior']) }),
  },
  {
    nombre: 'serie_metrica',
    descripcion: 'Serie temporal de una métrica por día o por semana, para graficar su evolución.',
    esquema: entrada({ metrica: { type: 'string' }, desde: FECHA, hasta: FECHA, granularidad: { enum: ['dia', 'semana'] } }, ['metrica', 'desde', 'hasta']),
    manejar: (a, _c, erp) => ({ ...erp.serieMetrica(a['metrica'], a['desde'], a['hasta'], a['granularidad']) }),
  },
  {
    nombre: 'detectar_anomalias',
    descripcion: 'Detecta comportamientos fuera de lo normal en un período: caídas o picos de ventas contra los mismos días de las semanas anteriores y diferencias en los arqueos de caja. Cada hallazgo explica por qué se marcó.',
    esquema: entrada({ desde: FECHA, hasta: FECHA }, ['desde', 'hasta']),
    manejar: (a, _c, erp) => ({ ...erp.detectarAnomalias(a['desde'], a['hasta']) }),
  },
  {
    nombre: 'consumir_eventos',
    descripcion: 'Lee los eventos de negocio posteriores a un cursor. Sin desde_secuencia no devuelve eventos: informa la posición actual.',
    esquema: entrada({ desde_secuencia: { type: 'integer', minimum: 0 }, tipos: { type: 'array', items: { type: 'string' } }, limite: { type: 'integer', minimum: 1, maximum: 500 } }),
    manejar: (a, _c, erp) => ({ ...erp.consumirEventos(a['desde_secuencia'], a['tipos'], a['limite']) }),
  },
  // ---- ventas
  {
    nombre: 'resumen_ventas',
    descripcion: 'Ventas de un período agrupadas por día, artículo, categoría o canal (tienda u online), con unidades, ingresos y margen.',
    esquema: entrada({ desde: FECHA, hasta: FECHA, agrupar_por: { enum: ['dia', 'articulo', 'categoria', 'canal'] } }, ['desde', 'hasta']),
    manejar: (a, _c, erp) => ({ ...erp.resumenVentas(a['desde'], a['hasta'], a['agrupar_por']) }),
  },
  {
    nombre: 'ranking_productos',
    descripcion: 'Ranking de artículos más vendidos en un período, ordenado por ingresos, unidades o margen.',
    esquema: entrada({ desde: FECHA, hasta: FECHA, orden: { enum: ['ingresos', 'unidades', 'margen'] }, limite: { type: 'integer', minimum: 1, maximum: 50 } }, ['desde', 'hasta']),
    manejar: (a, _c, erp) => ({ ...erp.rankingProductos(a['desde'], a['hasta'], a['orden'], a['limite']) }),
  },
  // ---- stock
  {
    nombre: 'buscar_articulos',
    descripcion: 'Busca artículos por nombre o categoría. Devuelve los códigos (articulo_id) con su stock. Usala antes de cualquier operación sobre un artículo.',
    esquema: entrada({ texto: { type: 'string', minLength: 2, description: 'Parte del nombre o la categoría.' } }, ['texto']),
    manejar: (a, _c, erp) => ({ ...erp.buscarArticulos(a['texto']) }),
  },
  {
    nombre: 'listar_stock',
    descripcion: 'Stock actual de todos los artículos, o solo los que están bajo el mínimo.',
    esquema: entrada({ solo_bajo_minimo: { type: 'boolean' } }),
    manejar: (a, _c, erp) => ({ ...erp.listarStock(a['solo_bajo_minimo']) }),
  },
  {
    nombre: 'obtener_articulo',
    descripcion: 'Ficha de un artículo: precio, costo, existencia, mínimo y proveedor.',
    esquema: entrada({ articulo_id: { type: 'string' } }, ['articulo_id']),
    manejar: (a, _c, erp) => ({ ...erp.obtenerArticulo(a['articulo_id']) }),
  },
  {
    nombre: 'preparar_ajuste_stock',
    descripcion: 'Prepara el ajuste de la existencia de un artículo (conteo físico, rotura, hallazgo). No cambia nada hasta que la persona confirma. Indicá existencia_nueva o variacion, y el motivo.',
    esquema: entrada({ articulo_id: { type: 'string' }, existencia_nueva: { type: 'integer', minimum: 0 }, variacion: { type: 'integer' }, motivo: { type: 'string', minLength: 3, maxLength: 120 } }, ['articulo_id', 'motivo']),
    manejar: (a, c, erp) => ({ ...erp.prepararAjusteStock(a, c) }),
  },
  { nombre: 'confirmar_ajuste_stock', descripcion: 'Confirma un ajuste de stock preparado. Lo llama el orquestador tras el toque de la persona.', esquema: confirmarEsquema(), manejar: async (a, c, erp) => ({ ...(await erp.confirmar('ajuste_stock', a, c)) }) },
  // ---- compras
  { nombre: 'listar_proveedores', descripcion: 'Proveedores con su plazo de entrega y cantidad de artículos que proveen.', esquema: entrada({}), manejar: (_a, _c, erp) => ({ ...erp.listarProveedores() }) },
  {
    nombre: 'listar_ordenes_compra',
    descripcion: 'Órdenes de compra, opcionalmente filtradas por estado (pendiente o recibida), con su total.',
    esquema: entrada({ estado: { enum: ['pendiente', 'recibida'] } }),
    manejar: (a, _c, erp) => ({ ...erp.listarOrdenesCompra(a['estado']) }),
  },
  {
    nombre: 'sugerir_compra',
    descripcion: 'Qué comprar: los artículos bajo el mínimo con la cantidad sugerida y su costo estimado, opcionalmente de un solo proveedor.',
    esquema: entrada({ proveedor_id: { type: 'string' } }),
    manejar: (a, _c, erp) => ({ ...erp.sugerirCompra(a['proveedor_id']) }),
  },
  {
    nombre: 'preparar_orden_compra',
    descripcion: 'Prepara una orden de compra a UN proveedor con sus líneas (articulo_id y cantidad). El servidor calcula los precios y el total. No se emite hasta que la persona confirma.',
    esquema: entrada(
      { proveedor_id: { type: 'string' }, items: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', required: ['articulo_id', 'cantidad'], additionalProperties: false, properties: { articulo_id: { type: 'string' }, cantidad: { type: ['integer', 'string'] } } } } },
      ['proveedor_id', 'items'],
    ),
    manejar: (a, c, erp) => ({ ...erp.prepararOrdenCompra(a, c) }),
  },
  { nombre: 'confirmar_orden_compra', descripcion: 'Confirma una orden de compra preparada. Lo llama el orquestador tras el toque de la persona.', esquema: confirmarEsquema(), manejar: async (a, c, erp) => ({ ...(await erp.confirmar('orden_compra', a, c)) }) },
  // ---- caja
  {
    nombre: 'estado_caja',
    descripcion: 'Estado de la caja de un día (por defecto hoy): apertura, ingresos, egresos, saldo esperado y, si hubo arqueo, lo contado y la diferencia.',
    esquema: entrada({ fecha: FECHA }),
    manejar: (a, _c, erp) => ({ ...erp.estadoCaja(a['fecha']) }),
  },
  {
    nombre: 'listar_movimientos_caja',
    descripcion: 'Movimientos de caja de un día (por defecto hoy).',
    esquema: entrada({ fecha: FECHA }),
    manejar: (a, _c, erp) => ({ ...erp.listarMovimientosCaja(a['fecha']) }),
  },
  {
    nombre: 'listar_arqueos',
    descripcion: 'Arqueos de caja de un período con lo esperado, lo contado y la diferencia.',
    esquema: entrada({ desde: FECHA, hasta: FECHA }, ['desde', 'hasta']),
    manejar: (a, _c, erp) => ({ ...erp.listarArqueos(a['desde'], a['hasta']) }),
  },
  {
    nombre: 'preparar_movimiento_caja',
    descripcion: 'Prepara un ingreso o un egreso de caja de hoy con su concepto e importe. Los egresos grandes necesitan autorización de un supervisor al confirmar. No se registra hasta que la persona confirma.',
    esquema: entrada({ tipo: { enum: ['ingreso', 'egreso'] }, concepto: { type: 'string', minLength: 3, maxLength: 80 }, importe: { type: ['string', 'number'], description: 'Importe tal como lo dijo la persona, sin símbolo de moneda.' } }, ['tipo', 'concepto', 'importe']),
    manejar: (a, c, erp) => ({ ...erp.prepararMovimientoCaja(a, c) }),
  },
  { nombre: 'confirmar_movimiento_caja', descripcion: 'Confirma un movimiento de caja preparado. Lo llama el orquestador tras el toque de la persona.', esquema: confirmarEsquema(), manejar: async (a, c, erp) => ({ ...(await erp.confirmar('movimiento_caja', a, c)) }) },
];

export const toolsMcp = (): ToolMcp[] => TOOLS.map((t) => ({ nombre: t.nombre, descripcion: t.descripcion, esquema: t.esquema }));

/**
 * Crea un servidor MCP con el ERP sintético. Valida la entrada de cada tool contra su JSON Schema y traduce los
 * `ErrorErp` a respuestas `isError` con la forma ErrorTool del contrato. `erp` queda expuesto para inspección en pruebas.
 */
export function crearServidorMcp(opciones: OpcionesErp = {}): { servidor: Server; erp: ErpSintetico } {
  const erp = new ErpSintetico(opciones);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validadores = new Map(TOOLS.map((t) => [t.nombre, ajv.compile(t.esquema)]));
  const servidor = new Server({ name: 'erp-sintetico', version: '0.1.0' }, { capabilities: { tools: {} } });

  servidor.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.nombre, description: t.descripcion, inputSchema: t.esquema as { type: 'object'; [k: string]: unknown } })),
  }));

  servidor.setRequestHandler(CallToolRequestSchema, async (req) => {
    const responder = (datos: Obj, esError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(datos) }], ...(esError ? { isError: true } : {}) });
    const def = TOOLS.find((t) => t.nombre === req.params.name);
    if (!def) return responder({ codigo: 'TOOL_DESCONOCIDA', mensaje: `No existe la tool ${req.params.name}.` }, true);
    const args = (req.params.arguments ?? {}) as Obj;
    const valida = validadores.get(def.nombre)!;
    if (!valida(args)) {
      const detalle = (valida.errors ?? []).map((e) => `${e.instancePath || '(raiz)'} ${e.message}`).join('; ');
      return responder({ codigo: 'PARAMETRO_INVALIDO', mensaje: `Parámetros inválidos: ${detalle}`, accion_sugerida: 'Corregí los parámetros y probá de nuevo.' }, true);
    }
    const ctx = args['contexto'] as ContextoSesion;
    try {
      return responder(await def.manejar(args, ctx, erp));
    } catch (e) {
      if (e instanceof ErrorErp) return responder({ codigo: e.codigo, mensaje: e.message, ...(e.accion_sugerida ? { accion_sugerida: e.accion_sugerida } : {}) }, true);
      return responder({ codigo: 'ERROR_INTERNO', mensaje: 'El servidor falló al procesar la operación.' }, true);
    }
  });
  return { servidor, erp };
}
