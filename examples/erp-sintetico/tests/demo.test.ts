import { describe, expect, it } from 'vitest';
import { correrDemo } from '../src/demo.js';

describe('demo de terminal', () => {
  it('cuenta la historia y verifica en runtime cada garantía', async () => {
    const lineas: string[] = [];
    const r = await correrDemo({ escribir: (l) => lineas.push(l) });
    expect(r.montoTarjeta).toEqual({ monto: '85.00', moneda: 'USD' });
    expect(r.stepUp).toBe('supervisor');
    expect(r.resultado?.['component']).toBe('StatusToast');
    expect(r.registrados).toBe(1);
    expect(r.movimientos.trasPropuesta).toBe(r.movimientos.inicio);
    expect(r.movimientos.final).toBe(r.movimientos.inicio + 1);
    expect(r.garantias).toHaveLength(4);
    expect(r.garantias.every((g) => g.ok)).toBe(true);
    expect(r.ok).toBe(true);
    const texto = lineas.join('\n');
    expect(texto).toContain('USD 85,00');
    expect(texto).toContain('preparar_movimiento_caja');
    expect(texto).toContain('importe: "85"');
    expect(texto).toContain('todavía no se escribió nada');
    expect(texto).toContain('****');
    expect(texto).not.toContain('2468');
    expect(texto.match(/\[ok\]/g)).toHaveLength(4);
    expect(texto).not.toContain('[FALLA]');
  });

  it('con un PIN incorrecto no escribe e informa [FALLA]', async () => {
    const lineas: string[] = [];
    const r = await correrDemo({ escribir: (l) => lineas.push(l), pin: '0000' });
    expect(r.ok).toBe(false);
    expect(r.movimientos.final).toBe(r.movimientos.inicio);
    expect(lineas.join('\n')).toContain('[FALLA]');
  });
});
