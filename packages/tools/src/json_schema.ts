import { z } from "zod";

/**
 * Convert a zod object schema into a JSON Schema fragment compatible with
 * OpenAI-compatible `tools[].function.parameters`. Other shapes fall back
 * to a permissive schema; the runtime pipeline still validates the input.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const v = value as z.ZodType;
      properties[key] = describeZod(v);
      if (!isOptional(v)) required.push(key);
    }
    return {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    };
  }
  return { type: "object", additionalProperties: true };
}

function describeZod(v: z.ZodType): Record<string, unknown> {
  const def = v._def as {
    typeName?: string;
    description?: string;
    innerType?: z.ZodType;
    values?: readonly string[];
  };
  const desc = def.description ? { description: def.description } : {};
  switch (def.typeName) {
    case "ZodString":
      return { type: "string", ...desc };
    case "ZodNumber":
      return { type: "number", ...desc };
    case "ZodBoolean":
      return { type: "boolean", ...desc };
    case "ZodArray": {
      const inner = def.innerType
        ? describeZod(def.innerType)
        : { type: "string" };
      return { type: "array", items: inner, ...desc };
    }
    case "ZodEnum":
      return {
        type: "string",
        enum: def.values ?? [],
        ...desc,
      };
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const inner = (def as unknown as { options?: z.ZodType[] }).options;
      return inner ? { anyOf: inner.map(describeZod) } : { ...desc };
    }
    case "ZodObject": {
      return zodToJsonSchema(v);
    }
    case "ZodLiteral": {
      const values = (def.values ?? []) as readonly unknown[];
      const sample = values[0];
      return { type: typeof sample, ...desc };
    }
    case "ZodOptional":
    case "ZodNullable":
      return def.innerType ? describeZod(def.innerType) : { type: "string" };
    case "ZodDefault":
      return def.innerType ? describeZod(def.innerType) : { type: "string" };
    default:
      return { ...desc };
  }
}

function isOptional(v: z.ZodType): boolean {
  const def = v._def as { typeName?: string };
  return def.typeName === "ZodOptional" ||
    def.typeName === "ZodNullable" ||
    def.typeName === "ZodDefault";
}
