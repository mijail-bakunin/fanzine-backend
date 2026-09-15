import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyAssistantMessage, simulateAssistantReply } from '../src/modules/assistant/assistant.service.js';
import { closeTestDatabase, createTestContext, prefix, type TestContext } from './helpers/test-context.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

describe('simulador determinista del asistente', () => {
  it.each([
    ['¡Hola!', 'greeting'], ['Quiero leer el archivo', 'archive'], ['¿Cómo puedo colaborar?', 'contribute'],
    ['Necesito ayuda', 'help'], ['this should not match', 'default'], ['Un mensaje sin palabras reconocidas', 'default'],
  ] as const)('clasifica %s como %s', (message, intent) => {
    expect(classifyAssistantMessage(message)).toBe(intent);
  });

  it('devuelve exactamente la misma respuesta para el mismo mensaje e idioma', () => {
    const first = simulateAssistantReply('archive issue', 'en');
    const second = simulateAssistantReply('archive issue', 'en');
    expect(first).toBe(second);
    expect(first).toContain('Archive');
  });
});

describe('POST /assistant/messages', () => {
  it.each([
    ['es', 'Hola', 'Hola.'],
    ['en', 'Hello', 'Hello.'],
    ['ru', 'Привет', 'Привет.'],
  ] as const)('responde anónimamente en %s', async (locale, message, prefixText) => {
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/assistant/messages`, payload: { message, locale } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      reply: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), role: 'assistant', text: expect.stringContaining(prefixText), createdAt: expect.any(String) },
      requestId: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.json().reply.createdAt))).toBe(false);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('conserva conversationId, usa ES por defecto y no depende de sesión ni CSRF', async () => {
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/assistant/messages`, payload: { message: 'Quiero recorrer una edición', conversationId: 'front_chat-123' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ conversationId: 'front_chat-123', reply: { role: 'assistant', text: expect.stringContaining('Archivo') } });
  });

  it.each([
    [{}, 'message'], [{ message: '' }, 'message'], [{ message: '   ' }, 'message'], [{ message: 'x'.repeat(1_001) }, 'message'],
    [{ message: 'hola', locale: 'fr' }, 'locale'], [{ message: 'hola', conversationId: '' }, 'conversationId'],
    [{ message: 'hola', conversationId: 'id con espacios' }, 'conversationId'], [{ message: 'hola', extra: true }, ''],
  ])('rechaza payload inválido %#', async (payload, field) => {
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/assistant/messages`, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'El pedido contiene datos inválidos.', requestId: expect.any(String) } });
    if (field) expect(JSON.stringify(response.json().error.details)).toContain(field);
  });

  it('aplica 10 solicitudes por minuto y devuelve headers estándar al excederlo', async () => {
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await context.app.inject({ method: 'POST', url: `${prefix}/assistant/messages`, remoteAddress: '203.0.113.77', payload: { message: `Mensaje ${index}` } }));
    }
    expect(responses.slice(0, 10).every(response => response.statusCode === 200)).toBe(true);
    expect(responses[10]!.statusCode).toBe(429);
    expect(responses[10]!.json()).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED', requestId: expect.any(String) } });
    expect(Number(responses[10]!.headers['retry-after'])).toBeGreaterThanOrEqual(0);
    expect(responses[10]!.headers['x-ratelimit-limit']).toBe('10');
  });

  it('publica el contrato completo y sin seguridad en OpenAPI', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/documentation/json' });
    const operation = response.json().paths['/assistant/messages'].post;
    expect(operation).toMatchObject({ operationId: 'sendAssistantMessage', security: [], requestBody: { required: true } });
    expect(operation.requestBody.content['application/json'].schema.properties).toHaveProperty('conversationId');
    expect(operation.responses).toHaveProperty('200');
    expect(operation.responses).toHaveProperty('400');
    expect(operation.responses).toHaveProperty('429');
  });
});
