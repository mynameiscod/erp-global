import { applyDecorators, PipeTransform } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';

/** `@Body(new ZodPipe(schema))` validates and returns the parsed (trimmed, defaulted) value. */
export class ZodPipe<S extends z.ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    return this.schema.parse(value ?? {});
  }
}

/** Documents a zod request body in OpenAPI. */
export function ApiZodBody(schema: z.ZodTypeAny) {
  let jsonSchema: Record<string, unknown>;
  try {
    jsonSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    delete jsonSchema.$schema;
  } catch {
    jsonSchema = { type: 'object' };
  }
  return applyDecorators(ApiBody({ schema: jsonSchema as never }));
}
