import { APP_VERSION } from '@jce/shared';
import { managementPaths } from './management/openapi.js';
const json = (schema: object) => ({
  content: { 'application/json': { schema } },
});
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'JCE POS API',
    version: APP_VERSION,
    description:
      'L3-L5 identity, branch administration, master data and inventory. HTTPS opaque sessions, origin/CSRF checks, live permissions, branch membership and reviewed idempotent stock posting. Checkout follows in a later phase.',
  },
  servers: [{ url: '/' }],
  paths: {
    ...managementPaths,
    '/health/live': {
      get: {
        summary: 'Process liveness',
        responses: {
          '200': {
            description: 'Process is running',
            ...json({
              type: 'object',
              properties: { status: { const: 'alive' } },
              required: ['status'],
            }),
          },
        },
      },
    },
    '/health/ready': {
      get: {
        summary: 'Database connectivity and exact migration compatibility',
        responses: {
          '200': {
            description: 'Ready',
            ...json({ $ref: '#/components/schemas/Readiness' }),
          },
          '503': {
            description: 'Not ready',
            ...json({ $ref: '#/components/schemas/Readiness' }),
          },
        },
      },
    },
    '/api/v1/version': {
      get: {
        summary: 'Application version',
        responses: {
          '200': {
            description: 'Version metadata',
            ...json({
              type: 'object',
              properties: {
                version: { type: 'string' },
                apiVersion: { const: 'v1' },
                schemaVersion: { type: 'integer' },
              },
              required: ['version', 'apiVersion', 'schemaVersion'],
            }),
          },
        },
      },
    },
    '/api/v1/openapi.json': {
      get: {
        summary: 'This OpenAPI document',
        responses: { '200': { description: 'OpenAPI 3.1 document' } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-jce_session',
        description:
          'Secure HttpOnly SameSite=Strict cookie. Explicit development loopback uses jce_session.',
      },
    },
    schemas: {
      Readiness: {
        type: 'object',
        properties: { status: { enum: ['ready', 'not_ready'] } },
        required: ['status'],
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string', format: 'uuid' },
            },
            required: ['code', 'message', 'requestId'],
          },
        },
        required: ['error'],
      },
      Pagination: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      },
    },
  },
};
