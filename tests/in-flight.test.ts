import { describe, expect, it, vi } from 'vitest';
import { createInFlightDeduplicator } from '../src/lib/in-flight.js';

describe('deduplicador de lecturas simultáneas', () => {
  it('comparte una operación mientras sigue en curso', async () => {
    let resolveOperation!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>(resolve => { resolveOperation = resolve; }));
    const deduplicate = createInFlightDeduplicator();

    const first = deduplicate('home:es', operation);
    const second = deduplicate('home:es', operation);
    resolveOperation('contenido');

    await expect(Promise.all([first, second])).resolves.toEqual(['contenido', 'contenido']);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('no conserva resultados después de completar la operación', async () => {
    const operation = vi.fn(async () => operation.mock.calls.length);
    const deduplicate = createInFlightDeduplicator();

    await expect(deduplicate('catalog:es', operation)).resolves.toBe(1);
    await expect(deduplicate('catalog:es', operation)).resolves.toBe(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('libera la clave también cuando la operación falla', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('fallo transitorio'))
      .mockResolvedValueOnce('recuperado');
    const deduplicate = createInFlightDeduplicator();

    await expect(deduplicate('search:es', operation)).rejects.toThrow('fallo transitorio');
    await expect(deduplicate('search:es', operation)).resolves.toBe('recuperado');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
