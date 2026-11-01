import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../auth/auth.controller';
import { makeAdmin, makePrincipal } from '../harness';

/**
 * ═══ F11: OpenAPI CONTRACT VALIDATION FOR SessionStatus ═════════════════════
 *
 * `GET /auth/session` returns five fields on a 200:
 *   - role ('ADMIN' | 'SUPER_ADMIN')
 *   - permissions (string[])
 *   - authenticated (true)
 *   - lastActiveAt (ISO 8601 string | null)
 *   - message ({ code: SessionMessageCode, text: string })
 *
 * Previously, openapi.json only declared three fields (`role`, `permissions`,
 * `authenticated`) with `additionalProperties: false`, which caused strict response
 * validators and client SDK generators to reject genuine 200 responses.
 *
 * These tests validate the actual runtime response returned by `AuthController.sessionStatus`
 * directly against the checked-in OpenAPI contract.
 */

interface SchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  items?: SchemaProperty;
  format?: string;
  $ref?: string;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, SchemaProperty>;
}

type ComponentSchema = SchemaProperty;

interface OpenApiSpec {
  paths: {
    '/auth/session': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  properties: {
                    data: { $ref: string };
                  };
                };
                examples?: {
                  signedIn?: {
                    value: {
                      data: Record<string, unknown>;
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  };
  components: {
    schemas: {
      SessionStatus: ComponentSchema;
      SessionMessage: ComponentSchema;
      [key: string]: ComponentSchema;
    };
  };
}

function loadOpenApiSpec(): OpenApiSpec {
  const specPath = resolve(process.cwd(), 'openapi.json');
  return JSON.parse(readFileSync(specPath, 'utf8')) as OpenApiSpec;
}

/**
 * Strict JSON Schema validator for the SessionStatus schema hierarchy.
 * Resolves local component refs and enforces `additionalProperties: false`.
 */
function validateAgainstSchema(
  value: unknown,
  schema: SchemaProperty | ComponentSchema,
  schemas: Record<string, ComponentSchema>,
  path = '',
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (schema.$ref) {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    const targetSchema = schemas[refName];
    if (!targetSchema) {
      errors.push(`Unresolved $ref: ${schema.$ref} at ${path}`);
      return { valid: false, errors };
    }
    return validateAgainstSchema(value, targetSchema, schemas, path);
  }

  // Type validation
  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType =
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

    if (!allowedTypes.includes(actualType)) {
      errors.push(
        `Expected type ${allowedTypes.join('|')} at ${path || 'root'}, got ${actualType}`,
      );
      return { valid: false, errors };
    }
  }

  // Enum validation
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(
      `Value ${JSON.stringify(value)} at ${path || 'root'} not in enum: ${JSON.stringify(schema.enum)}`,
    );
  }

  // Object validation
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = schema.required || [];

    for (const reqKey of required) {
      if (!(reqKey in obj)) {
        errors.push(`Missing required field '${reqKey}' at ${path || 'root'}`);
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      const allowedKeys = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowedKeys.has(key)) {
          errors.push(
            `Unexpected property '${key}' at ${path || 'root'} (additionalProperties: false)`,
          );
        }
      }
    }

    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (propName in obj) {
          const propResult = validateAgainstSchema(
            obj[propName],
            propSchema,
            schemas,
            path ? `${path}.${propName}` : propName,
          );
          errors.push(...propResult.errors);
        }
      }
    }
  }

  // Array validation
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      const itemResult = validateAgainstSchema(
        item,
        schema.items!,
        schemas,
        `${path}[${index}]`,
      );
      errors.push(...itemResult.errors);
    });
  }

  // Date-time format validation
  if (schema.format === 'date-time' && typeof value === 'string') {
    const date = new Date(value);
    if (isNaN(date.getTime()) || !value.includes('T')) {
      errors.push(`Invalid date-time string '${value}' at ${path}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

describe('F11 — SessionStatus OpenAPI contract & response validation', () => {
  const spec = loadOpenApiSpec();
  const schemas = spec.components.schemas;
  const statusSchema = schemas.SessionStatus;
  const messageSchema = schemas.SessionMessage;

  const ADMIN_ID = '01920000-0000-7000-8000-00000000000a';
  const ACTIVE_AT = new Date('2026-09-08T10:05:00.000Z');

  function buildController(role: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN') {
    const admin = makeAdmin({ id: ADMIN_ID, role });
    const admins = { findById: vi.fn().mockResolvedValue(admin) };
    const controller = new AuthController(
      {} as never,
      {} as never,
      admins as never,
      {} as never,
      {} as never,
    );
    const principal = makePrincipal({ adminId: ADMIN_ID, role });
    return { controller, principal };
  }

  it('declares all five fields as required with additionalProperties: false in openapi.json', () => {
    expect(statusSchema).toBeDefined();
    expect(statusSchema.type).toBe('object');
    expect(statusSchema.additionalProperties).toBe(false);

    expect(statusSchema.required).toEqual(
      expect.arrayContaining(['role', 'permissions', 'authenticated', 'lastActiveAt', 'message']),
    );
    expect(statusSchema.required).toHaveLength(5);

    expect(statusSchema.properties).toHaveProperty('role');
    expect(statusSchema.properties).toHaveProperty('permissions');
    expect(statusSchema.properties).toHaveProperty('authenticated');
    expect(statusSchema.properties).toHaveProperty('lastActiveAt');
    expect(statusSchema.properties).toHaveProperty('message');
  });

  it('declares SessionMessage schema with code enum and text string', () => {
    expect(messageSchema).toBeDefined();
    expect(messageSchema.type).toBe('object');
    expect(messageSchema.additionalProperties).toBe(false);
    expect(messageSchema.required).toEqual(expect.arrayContaining(['code', 'text']));

    const codeProp = messageSchema.properties?.code;
    expect(codeProp?.type).toBe('string');
    expect(codeProp?.enum).toEqual(
      expect.arrayContaining([
        'LOGGED_IN',
        'SESSION_EXPIRED',
        'SESSION_REVOKED',
        'SESSION_REVOKED_ALL',
        'NOT_LOGGED_IN',
      ]),
    );

    const textProp = messageSchema.properties?.text;
    expect(textProp?.type).toBe('string');
  });

  it('validates actual successful response against the published OpenAPI SessionStatus schema', async () => {
    const { controller, principal } = buildController('ADMIN');
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    const result = validateAgainstSchema(data, statusSchema, schemas);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates actual response when lastActiveAt is null', async () => {
    const { controller, principal } = buildController('ADMIN');
    const { data } = await controller.sessionStatus(principal, null);

    expect(data.lastActiveAt).toBeNull();
    const result = validateAgainstSchema(data, statusSchema, schemas);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates actual response for SUPER_ADMIN role', async () => {
    const { controller, principal } = buildController('SUPER_ADMIN');
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data.role).toBe('SUPER_ADMIN');
    const result = validateAgainstSchema(data, statusSchema, schemas);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates that the published 200 example in openapi.json matches SessionStatus schema', () => {
    const example =
      spec.paths['/auth/session'].get.responses['200'].content['application/json'].examples?.signedIn?.value.data;

    expect(example).toBeDefined();
    const result = validateAgainstSchema(example, statusSchema, schemas);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects an outdated 3-field response missing lastActiveAt and message', () => {
    const outdatedPayload = {
      role: 'ADMIN',
      permissions: [],
      authenticated: true,
    };

    const result = validateAgainstSchema(outdatedPayload, statusSchema, schemas);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field 'lastActiveAt' at root");
    expect(result.errors).toContain("Missing required field 'message' at root");
  });

  it('rejects a response carrying unexpected fields due to additionalProperties: false', () => {
    const leakedPayload = {
      role: 'ADMIN',
      permissions: [],
      authenticated: true,
      lastActiveAt: '2026-09-08T10:05:00.000Z',
      message: { code: 'LOGGED_IN', text: 'You are logged in.' },
      sessionId: '01920000-0000-7000-8000-00000000000b',
    };

    const result = validateAgainstSchema(leakedPayload, statusSchema, schemas);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Unexpected property 'sessionId' at root (additionalProperties: false)",
    );
  });
});
