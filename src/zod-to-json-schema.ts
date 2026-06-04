// Minimal zod → JSON-Schema converter. We only support the shapes our
// tool inputs use (object roots with string/number/boolean/enum/optional/
// default leaves + a description). This avoids pulling in the heavy
// `zod-to-json-schema` npm package for a couple-hundred-byte job.

import { z } from 'zod';

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

function leafSchema(schema: z.ZodTypeAny): JsonSchema {
  // Peel optional/default/describe wrappers, recording metadata as we go.
  let cur: z.ZodTypeAny = schema;
  let description: string | undefined;
  let defaultValue: unknown;

  // Capture `.describe(...)` text from any wrapper level.
  if ((cur as z.ZodTypeAny & { description?: string }).description) {
    description = (cur as z.ZodTypeAny & { description?: string }).description;
  }
  while (
    cur instanceof z.ZodOptional ||
    cur instanceof z.ZodDefault ||
    cur instanceof z.ZodNullable
  ) {
    if (cur instanceof z.ZodDefault) {
      defaultValue = cur._def.defaultValue();
    }
    cur = (cur._def as { innerType?: z.ZodTypeAny }).innerType ?? cur;
    if (
      !description &&
      (cur as z.ZodTypeAny & { description?: string }).description
    ) {
      description = (cur as z.ZodTypeAny & { description?: string }).description;
    }
  }

  const out: JsonSchema = {};

  if (cur instanceof z.ZodString) out.type = 'string';
  else if (cur instanceof z.ZodNumber) {
    out.type = 'number';
    // z.number().int() — there's no clean API, but checks live on _def.checks.
    const checks = (cur._def as { checks?: { kind: string; value?: number }[] })
      .checks;
    if (checks) {
      for (const c of checks) {
        if (c.kind === 'int') out.type = 'integer';
        if (c.kind === 'min' && typeof c.value === 'number') out.minimum = c.value;
        if (c.kind === 'max' && typeof c.value === 'number') out.maximum = c.value;
      }
    }
  } else if (cur instanceof z.ZodBoolean) out.type = 'boolean';
  else if (cur instanceof z.ZodEnum) {
    out.type = 'string';
    out.enum = [...(cur as z.ZodEnum<[string, ...string[]]>).options];
  } else if (cur instanceof z.ZodLiteral) {
    out.enum = [(cur as z.ZodLiteral<unknown>).value];
  } else if (cur instanceof z.ZodArray) {
    out.type = 'array';
  } else if (cur instanceof z.ZodObject) {
    // Nested object — recurse via the public path.
    return zodToJsonSchema(cur);
  } else {
    // Unknown / unsupported — fall back to "any".
  }

  if (description) out.description = description;
  if (defaultValue !== undefined) out.default = defaultValue;
  return out;
}

export function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema.shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = leafSchema(value as z.ZodTypeAny);
    const isOptional =
      value instanceof z.ZodOptional || value instanceof z.ZodDefault;
    if (!isOptional) required.push(key);
  }
  const out: JsonSchema = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) out.required = required;
  return out;
}
