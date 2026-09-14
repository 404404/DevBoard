import {
  CreateGlobalLabelCommandSchema,
  DeleteGlobalLabelCommandSchema,
  EntityIdSchema,
  IdempotencyKeySchema,
  ReorderGlobalLabelsCommandSchema,
  UpdateGlobalLabelCommandSchema,
} from "@lark-taskboard/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { sessionCookieNames, type IdentityService } from "../identity/index.js";
import type { MutationContext } from "../taskboard/index.js";
import type { LabelCatalog } from "./label-catalog.js";

const LabelParamsSchema = z.object({ labelId: EntityIdSchema });

interface LabelRoutesOptions {
  readonly config: AppConfig;
  readonly identityService: IdentityService;
  readonly labels: LabelCatalog;
}

function authenticate(request: FastifyRequest, options: LabelRoutesOptions) {
  const names = sessionCookieNames(options.config);
  return options.identityService.authenticate(request.cookies[names.session]);
}

function mutationContext(request: FastifyRequest, options: LabelRoutesOptions): MutationContext {
  const names = sessionCookieNames(options.config);
  const session = options.identityService.authenticate(request.cookies[names.session]);
  const csrfHeader = request.headers["x-csrf-token"];
  options.identityService.assertCsrf(
    session,
    typeof csrfHeader === "string" ? csrfHeader : undefined,
    request.cookies[names.csrf],
  );
  const idempotencyHeader = request.headers["idempotency-key"];
  return {
    actor: session.actor,
    idempotencyKey: IdempotencyKeySchema.parse(
      typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    ),
    requestId: request.id,
  };
}

export function registerLabelRoutes(app: FastifyInstance, options: LabelRoutesOptions): void {
  app.get("/api/v1/labels", async (request) => {
    const session = authenticate(request, options);
    return { data: options.labels.list(session.actor) };
  });

  app.post("/api/v1/labels", async (request, reply) => {
    const result = options.labels.create(
      CreateGlobalLabelCommandSchema.parse(request.body),
      mutationContext(request, options),
    );
    await reply.code(201).send({ data: result.label, meta: { revision: result.revision } });
  });

  app.patch("/api/v1/labels/:labelId", async (request) => {
    const { labelId } = LabelParamsSchema.parse(request.params);
    const result = options.labels.update(
      labelId,
      UpdateGlobalLabelCommandSchema.parse(request.body),
      mutationContext(request, options),
    );
    return { data: result.label, meta: { revision: result.revision } };
  });

  app.delete("/api/v1/labels/:labelId", async (request) => {
    const { labelId } = LabelParamsSchema.parse(request.params);
    const result = options.labels.delete(
      labelId,
      DeleteGlobalLabelCommandSchema.parse(request.body),
      mutationContext(request, options),
    );
    return { data: { labelId: result.labelId }, meta: { revision: result.revision } };
  });

  app.put("/api/v1/labels/order", async (request) => {
    const result = options.labels.reorder(
      ReorderGlobalLabelsCommandSchema.parse(request.body),
      mutationContext(request, options),
    );
    return { data: { labels: result.labels }, meta: { revision: result.revision } };
  });
}
