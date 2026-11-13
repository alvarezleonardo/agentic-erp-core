/** Un agente de dominio: prompt propio, un conjunto acotado de tools y los componentes que puede emitir. */

export const MAX_TOOLS_POR_AGENTE = 15;
export const MAX_PASOS_POR_AGENTE = 6;

export interface OpcionesReglasComunes {
  /** Idioma y registro en que habla el agente. Por defecto «español rioplatense». */
  registro?: string;
}

export const REGISTRO_POR_DEFECTO = 'español rioplatense';

/** Reglas que comparten todos los agentes. `definirAgente` las antepone al prompt de cada uno. */
export const reglasComunes = (opciones: OpcionesReglasComunes = {}): string => `Sos un agente de un ERP. Hablás en ${opciones.registro ?? REGISTRO_POR_DEFECTO}, directo y breve. La persona que te habla gestiona el negocio: no tiene tiempo para explicaciones largas.

REGLAS DURAS (no se negocian):
1. En la gestión, vos PROPONÉS y la persona DECIDE. Nunca ejecutás nada: lo que cambia datos solo se prepara.
2. NUNCA calcules, estimes, redondees ni escribas montos, totales ni porcentajes. Todo importe lo calcula el servidor y llega en los resultados de los tools. Tampoco los repitas en texto libre: se muestran dentro del componente.
3. Para cualquier dato (ventas, stock, compras, caja) usá tools. No supongas nada de memoria.
4. Si hay ambigüedad (por ejemplo dos insumos que se llaman parecido, o falta un dato), NO elijas por la persona: terminá con clarify, con opciones que sean ids reales devueltos por un tool.
5. Los tools que empiezan con "preparar_" solo arman una propuesta: no hacen nada todavía. La confirmación la hace la persona tocando un botón en la pantalla. Vos no confirmás nada y no existe ninguna función para eso. Nunca digas que algo "ya quedó hecho" si solo lo preparaste.
6. No manejás identidad, permisos, claves ni PIN: el sistema pone quién es la persona y la pantalla pide cualquier autorización al confirmar. No los pidas ni los inventes.
7. TERMINÁ SIEMPRE tu turno llamando a UNA de estas funciones: render_ui, clarify o report_error. Nunca contestes con texto suelto.
   - render_ui: component + proposal_id (el proposal_id que devolvió un preparar_*, o el source_id de una lectura). No escribas data con montos; el servidor la completa. speech: una sola oración corta, sin cifras.
   - clarify: pregunta corta + opciones (id real de un resultado de tool).
   - report_error: codigo del error del tool (o AGENTE_SIN_RESOLUCION) + mensaje corto sin jerga y sin importes.
8. Si un tool devuelve un error, no reintentes a ciegas: si podés corregirlo, hacelo una vez; si no, report_error con el código y qué puede hacer la persona.
9. Tenés un máximo de ${MAX_PASOS_POR_AGENTE} pasos. Sé eficiente: pedí solo los datos que necesitás.`;

/** Las reglas comunes con el registro por defecto. */
export const REGLAS_COMUNES = reglasComunes();

export interface AgentConfig {
  nombre: string;
  /** Dominio del router que lo activa. */
  dominio: string;
  descripcion: string;
  systemPrompt: string;
  tools: string[];
  componentes: string[];
  maxPasos?: number;
}

export interface DefinicionAgente extends Omit<AgentConfig, 'systemPrompt'> {
  /** Instrucciones propias del dominio. Se les antepone REGLAS_COMUNES. */
  prompt: string;
  /** Idioma y registro del agente (por defecto «español rioplatense»); ver `reglasComunes`. */
  registro?: string;
}

/** Crea un agente validando el diseño: ≤15 tools, sin confirmar_*, sin duplicados, con componentes. */
export function definirAgente(def: DefinicionAgente): AgentConfig {
  const { prompt, registro, ...resto } = def;
  if (def.tools.length > MAX_TOOLS_POR_AGENTE) {
    throw new Error(`El agente ${def.nombre} tiene ${def.tools.length} tools; el máximo es ${MAX_TOOLS_POR_AGENTE}. Partilo en dos dominios (ADR-002).`);
  }
  if (new Set(def.tools).size !== def.tools.length) throw new Error(`El agente ${def.nombre} repite tools`);
  const confirmar = def.tools.filter((t) => t.startsWith('confirmar_'));
  if (confirmar.length) throw new Error(`El agente ${def.nombre} no puede llamar ${confirmar.join(', ')}: las confirmaciones las hace la persona`);
  if (def.componentes.length === 0) throw new Error(`El agente ${def.nombre} no declara componentes`);
  return { ...resto, systemPrompt: `${reglasComunes(registro ? { registro } : {})}\n\n${prompt}` };
}

/** Los agentes de un despliegue, por dominio. */
export class RegistroAgentes {
  private readonly porDominio = new Map<string, AgentConfig>();

  constructor(agentes: readonly AgentConfig[]) {
    for (const a of agentes) {
      if (this.porDominio.has(a.dominio)) throw new Error(`Dominio duplicado: ${a.dominio}`);
      this.porDominio.set(a.dominio, a);
    }
  }

  get(dominio: string): AgentConfig | undefined {
    return this.porDominio.get(dominio);
  }

  dominios(): string[] {
    return [...this.porDominio.keys()];
  }

  todos(): AgentConfig[] {
    return [...this.porDominio.values()];
  }

  /** Devuelve los problemas de cablear estos agentes contra el catálogo real de un servidor MCP. */
  validarContraCatalogo(toolsDisponibles: readonly string[]): string[] {
    const hay = new Set(toolsDisponibles);
    const problemas: string[] = [];
    for (const a of this.porDominio.values()) {
      for (const t of a.tools) if (!hay.has(t)) problemas.push(`${a.nombre}: la tool ${t} no existe en el servidor`);
      for (const t of a.tools) if (t.startsWith('preparar_') && !hay.has(`confirmar_${t.slice('preparar_'.length)}`)) problemas.push(`${a.nombre}: ${t} no tiene su confirmar_`);
    }
    return problemas;
  }
}
