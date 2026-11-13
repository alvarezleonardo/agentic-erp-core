import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Trace, contieneMonto, esFinal, parsearDirectiva, quitarSecretos, redactar, MemoriaIntencion, MemoriaSesion, Permisos, foco, ContractValidator, DIR_GENUI } from '../src/index.js';

describe('quitarSecretos y redactar', () => {
  it('quita claves con token, pin, secret, password o api key en cualquier nivel', () => {
    const limpio = quitarSecretos({ proposal_id: 'p', confirmation_token: 'T', anidado: { supervisor_pin: '1234', pin: '1', ok: 1 }, lista: [{ apiKey: 'k', api_key: 'k', password: 'x', dato: 2 }] });
    expect(limpio).toEqual({ proposal_id: 'p', anidado: { ok: 1 }, lista: [{ dato: 2 }] });
  });

  it('no confunde «pin» con palabras que lo contienen', () => {
    expect(quitarSecretos({ pinza: 1, pintura: 2, pin: 3 })).toEqual({ pinza: 1, pintura: 2 });
  });

  it('la autorización de un step-up: el PIN se quita y se redacta, el motivo queda', () => {
    const autorizacion = { usuario: 'sup1', pin: '2468', motivo: 'Pago de flete' };
    expect(quitarSecretos({ autorizacion })).toEqual({ autorizacion: { usuario: 'sup1', motivo: 'Pago de flete' } });
    expect(redactar({ autorizacion })).toEqual({ autorizacion: { usuario: 'sup1', pin: '[redactado]', motivo: 'Pago de flete' } });
  });

  it('redactar deja una marca y oculta claves de API con forma conocida', () => {
    expect(redactar({ confirmation_token: 'abc', texto: 'sk-abcdefghijklmnopqrstuv', ok: 'sí' })).toEqual({ confirmation_token: '[redactado]', texto: '[redactado]', ok: 'sí' });
  });
});

describe('contieneMonto', () => {
  it('detecta símbolos de moneda, miles, decimales y números largos', () => {
    for (const t of ['son $ 100', '1.234,50 en total', 'cuesta 84.60', 'orden 123456', 'Son 1 dólar.', 'unos 50 USD', 'USD 20']) expect(contieneMonto(t)).toBe(true);
  });
  it('deja pasar números chicos', () => {
    for (const t of ['3 unidades', 'la semana 12', 'hay 24 artículos']) expect(contieneMonto(t)).toBe(false);
  });
});

describe('directivas', () => {
  it('reconoce las tres finales', () => {
    expect(['render_ui', 'clarify', 'report_error'].every(esFinal)).toBe(true);
    expect(esFinal('leer_tabla')).toBe(false);
  });

  it('valida la forma de cada directiva', () => {
    expect(parsearDirectiva('render_ui', {}).ok).toBe(false);
    expect(parsearDirectiva('render_ui', { component: 'DataTable', data: [] }).ok).toBe(false);
    expect(parsearDirectiva('clarify', { pregunta: 'x' }).ok).toBe(false);
    expect(parsearDirectiva('report_error', { codigo: 'X' }).ok).toBe(false);
    const ok = parsearDirectiva('render_ui', { component: 'DataTable', proposal_id: 'res_1', actions: [{ id: 'cerrar', label: 'Cerrar' }, { sin_id: true }] });
    expect(ok.ok && ok.directiva.tipo === 'render_ui' && ok.directiva.actions).toEqual([{ id: 'cerrar', label: 'Cerrar' }]);
  });

  it('convierte render_ui de Clarification en la directiva clarify', () => {
    const r = parsearDirectiva('render_ui', { component: 'Clarification', data: { pregunta: '¿Cuál?', opciones: [{ id: 'a' }, { id: 'b' }] } });
    expect(r.ok && r.directiva.tipo).toBe('clarify');
  });
});

describe('memoria', () => {
  it('la memoria de la intención guarda ids y nunca importes ni tokens', () => {
    const m = new MemoriaIntencion();
    m.absorber({ proveedor_id: 'prv_02', proposal_id: 'p1', total: { monto: '10.00' }, confirmation_token: 'x', cantidad: 3 });
    expect([...m.entidades]).toEqual([['proveedor_id', 'prv_02']]);
    expect(m.texto()).toBe('proveedor_id=prv_02');
  });

  it('la memoria de sesión conserva una ventana de 5 intenciones y el último foco', () => {
    const s = new MemoriaSesion();
    for (let i = 1; i <= 7; i++) s.recordar({ texto: `frase ${i}`, dominios: ['ventas'], ...(i === 3 ? { foco: { tipo: 'proveedor', id: 'prv_01' } } : {}) });
    expect(s.ultimas).toHaveLength(5);
    expect(s.ultimas[0]?.texto).toBe('frase 3');
    expect(s.texto()).toContain('proveedor prv_01');
  });
});

describe('Permisos', () => {
  const p = new Permisos({ porTool: { preparar_orden: ['gerente'] }, porDefecto: 'todos' });
  it('confirmar_x hereda la entrada de preparar_x', () => {
    expect(p.puede('preparar_orden', 'gerente')).toBe(true);
    expect(p.puede('preparar_orden', 'operador')).toBe(false);
    expect(p.puede('confirmar_orden', 'operador')).toBe(false);
    expect(p.puede('listar_cosas', 'operador')).toBe(true);
  });
  it('porDefecto restringe las tools sin entrada', () => {
    const cerrado = new Permisos({ porDefecto: ['gerente'] });
    expect(cerrado.puede('lo_que_sea', 'operador')).toBe(false);
    expect(cerrado.filtrar(['a', 'b'], 'gerente')).toEqual(['a', 'b']);
  });
});

describe('Trace', () => {
  it('redacta antes de guardar y filtra por intención', () => {
    const t = new Trace();
    t.registrar('tr1', 'int1', 'x', { confirmation_token: 'secreto', pin: '1234', ok: 1 });
    t.registrar('tr1', 'int2', 'y');
    expect(t.serializado()).not.toContain('secreto');
    expect(t.serializado()).not.toContain('1234');
    expect(t.porIntencion('int1')).toHaveLength(1);
  });
});

describe('contieneMonto: formatos regionales', () => {
  it('detecta miles y decimales en formato es-AR y en-US', () => {
    for (const t of ['$ 12.450,75', 'son 12.450,75 en total', 'total 1,234.56', 'unos 1.234', '1,234', '12,450.75 pesos']) expect(contieneMonto(t)).toBe(true);
  });
});

describe('foco de la memoria', () => {
  const memoria = (): MemoriaIntencion => {
    const m = new MemoriaIntencion();
    m.absorber({ id: 'x', tenant_id: 't1', empresa_id: 'e1', proveedor_id: 'prv_01' });
    return m;
  };

  it('por defecto ignora id y tenant_id', () => {
    expect(foco(memoria())).toEqual({ tipo: 'empresa', id: 'e1' });
  });

  it('las claves ignoradas son configurables', () => {
    expect(foco(memoria(), ['id', 'tenant_id', 'empresa_id'])).toEqual({ tipo: 'proveedor', id: 'prv_01' });
    expect(foco(memoria(), ['id'])).toEqual({ tipo: 'tenant', id: 't1' });
  });
});

describe('ContractValidator: directorio de schemas', () => {
  it('acepta el directorio por parámetro', () => {
    const copia = join(mkdtempSync(join(tmpdir(), 'genui-')), 'genui');
    cpSync(DIR_GENUI, copia, { recursive: true });
    const v = new ContractValidator(copia);
    expect(v.componente('ConfirmationCard', 1)).toBeDefined();
  });

  it('falla con un mensaje claro si el directorio no tiene los schemas', () => {
    expect(() => new ContractValidator(join(tmpdir(), 'no-existe-genui'))).toThrowError(/CONTRACTS_DIR/);
  });
});
