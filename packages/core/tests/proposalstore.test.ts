import { describe, expect, it } from 'vitest';
import { ProposalStore } from '../src/index.js';

const propuesta = (id: string, token = `cft_${id}_0123456789abcdef`) => ({ proposal_id: id, confirmation_token: token, titulo: 'T', total: { monto: '10.00', moneda: 'USD' } });

describe('ProposalStore', () => {
  it('guarda la salida literal (con token) y deja una versión sin secretos para el modelo', () => {
    const s = new ProposalStore();
    const f = s.guardarPropuesta('preparar_x', { a: 1 }, propuesta('p1'), 'int_1', 'ag');
    expect(s.tokenDe('p1')).toBe('cft_p1_0123456789abcdef');
    const visto = ProposalStore.paraLlm(f.salida);
    expect(JSON.stringify(visto)).not.toContain('cft_');
    expect(visto['proposal_id']).toBe('p1');
    expect(visto['total']).toEqual({ monto: '10.00', moneda: 'USD' });
  });

  it('las lecturas reciben un source_id y las tablas largas se recortan solo para el modelo', () => {
    const s = new ProposalStore();
    const filas = Array.from({ length: 100 }, (_, i) => ({ n: i }));
    const f = s.guardarLectura('listar_x', {}, { columnas: [], filas }, 'int_abcdef', 'ag');
    expect(f.id).toMatch(/^res_1_/);
    const visto = ProposalStore.paraLlm(f.salida, f);
    expect(visto['source_id']).toBe(f.id);
    expect((visto['filas'] as unknown[]).length).toBe(40);
    expect(visto['filas_omitidas']).toBe(60);
    expect((s.get(f.id)?.salida['filas'] as unknown[]).length).toBe(100);
  });

  it('una propuesta nueva de la misma tool e intención reemplaza a la anterior', () => {
    const s = new ProposalStore();
    s.guardarPropuesta('preparar_x', {}, propuesta('p1'), 'int_1', 'ag');
    s.guardarPropuesta('preparar_x', {}, propuesta('p2'), 'int_1', 'ag');
    s.guardarPropuesta('preparar_y', {}, propuesta('p3'), 'int_1', 'ag');
    expect(s.get('p1')?.estado).toBe('reemplazada');
    expect(s.get('p2')?.estado).toBe('abierta');
    expect(s.get('p3')?.estado).toBe('abierta');
    expect(s.tokenDe('p1')).toBeUndefined();
  });

  it('compara el token en tiempo constante y rechaza vacíos y ajenos', () => {
    const s = new ProposalStore();
    s.guardarPropuesta('preparar_x', {}, propuesta('p1'), 'int_1', 'ag');
    expect(s.tokenCoincide('p1', 'cft_p1_0123456789abcdef')).toBe(true);
    expect(s.tokenCoincide('p1', 'cft_otro_0123456789abcdef')).toBe(false);
    expect(s.tokenCoincide('p1', undefined)).toBe(false);
    expect(s.tokenCoincide('inexistente', 'x')).toBe(false);
  });

  it('abandonar una intención cierra solo sus propuestas abiertas', () => {
    const s = new ProposalStore();
    s.guardarPropuesta('preparar_x', {}, propuesta('p1'), 'int_1', 'ag');
    s.guardarPropuesta('preparar_x', {}, propuesta('p2'), 'int_2', 'ag');
    expect(s.abandonarIntencion('int_1')).toEqual(['p1']);
    expect(s.get('p1')?.estado).toBe('abandonada');
    expect(s.get('p2')?.estado).toBe('abierta');
  });

  it('descarta las fuentes viejas', () => {
    let ahora = 0;
    const s = new ProposalStore(() => ahora);
    s.guardarLectura('listar_x', {}, {}, 'int_aaaaaa', 'ag');
    ahora = 16 * 60_000;
    s.guardarLectura('listar_y', {}, {}, 'int_bbbbbb', 'ag');
    expect(s.deIntencion('int_aaaaaa')).toHaveLength(0);
  });
});
