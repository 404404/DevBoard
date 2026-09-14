import type { ServerResponse } from "node:http";

import {
  EventFeedQuerySchema,
  EventStreamMessageSchema,
  RevisionSchema,
  type EventStreamMessage,
} from "@lark-codex/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AppConfig } from "../../config.js";
import {
  sessionCookieNames,
  type IdentityService,
  type SessionContext,
} from "../identity/index.js";
import type { EventFeed } from "./event-feed.js";

interface EventFeedRoutesOptions {
  readonly config: AppConfig;
  readonly eventFeed: EventFeed;
  readonly identityService: IdentityService;
}

function authenticate(
  request: FastifyRequest,
  config: AppConfig,
  identityService: IdentityService,
): SessionContext {
  const names = sessionCookieNames(config, request.cookies);
  return identityService.authenticate(request.cookies[names.session]);
}

function acceptsEventStream(request: FastifyRequest): boolean {
  return (
    request.headers.accept
      ?.split(",")
      .some((value) => value.trim().toLowerCase().startsWith("text/event-stream")) ?? false
  );
}

function reconnectRevision(request: FastifyRequest, fallback: number): number {
  const header = request.headers["last-event-id"];
  if (header === undefined) {
    return fallback;
  }
  return RevisionSchema.parse(Number(header));
}

export function serializeSseMessage(message: EventStreamMessage): string {
  const parsed = EventStreamMessageSchema.parse(message);
  if (parsed.kind === "change") {
    return `id: ${parsed.revision}\nevent: ${parsed.event.eventType}\ndata: ${JSON.stringify(parsed.event)}\n\n`;
  }
  if (parsed.kind === "cursor") {
    return `id: ${parsed.revision}\nevent: cursor\ndata: ${JSON.stringify({ revision: parsed.revision })}\n\n`;
  }
  return `id: ${parsed.revision}\nevent: refresh-required\ndata: ${JSON.stringify({ revision: parsed.revision, reason: parsed.reason })}\n\n`;
}

function writeChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return Promise.resolve(false);
  }
  if (response.write(chunk)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const finish = (writable: boolean) => {
      clearTimeout(timeout);
      response.off("drain", onDrain);
      response.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      resolve(writable);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onAbort = () => finish(false);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    response.once("drain", onDrain);
    response.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function heartbeat(ms: number): { readonly promise: Promise<void>; cancel(): void } {
  let timeout: NodeJS.Timeout | undefined;
  return {
    promise: new Promise((resolve) => {
      timeout = setTimeout(resolve, ms);
    }),
    cancel() {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}

async function streamEvents(
  request: FastifyRequest,
  response: ServerResponse,
  eventFeed: EventFeed,
  projectId: string,
  afterRevision: number,
  config: AppConfig,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  response.once("close", abort);
  const iterator = eventFeed
    .subscribe({ projectId, afterRevision, signal: controller.signal })
    [Symbol.asyncIterator]();

  try {
    if (
      !(await writeChunk(
        response,
        `retry: ${config.LARK_CODEX_SSE_RETRY_MS}\n\n`,
        controller.signal,
        config.LARK_CODEX_SSE_WRITE_TIMEOUT_MS,
      ))
    ) {
      return;
    }
    let nextMessage = iterator.next();
    while (!controller.signal.aborted) {
      const heartbeatWait = heartbeat(config.LARK_CODEX_SSE_HEARTBEAT_MS);
      const result = await Promise.race([
        nextMessage.then((value) => ({ kind: "message" as const, value })),
        heartbeatWait.promise.then(() => ({ kind: "heartbeat" as const })),
      ]);
      heartbeatWait.cancel();

      if (result.kind === "heartbeat") {
        const writable = await writeChunk(
          response,
          `: heartbeat ${Date.now()}\n\n`,
          controller.signal,
          config.LARK_CODEX_SSE_WRITE_TIMEOUT_MS,
        );
        if (!writable) {
          return;
        }
        continue;
      }
      if (result.value.done) {
        return;
      }
      const writable = await writeChunk(
        response,
        serializeSseMessage(result.value.value),
        controller.signal,
        config.LARK_CODEX_SSE_WRITE_TIMEOUT_MS,
      );
      if (!writable || result.value.value.kind === "refresh_required") {
        return;
      }
      nextMessage = iterator.next();
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      request.log.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : "事件流内部错误",
        },
        "Event stream closed after an internal error",
      );
    }
  } finally {
    controller.abort();
    request.raw.off("aborted", abort);
    response.off("close", abort);
    await iterator.return?.();
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }
}

export function registerEventFeedRoutes(
  app: FastifyInstance,
  options: EventFeedRoutesOptions,
): void {
  const { config, eventFeed, identityService } = options;

  app.get("/api/v1/events", async (request, reply) => {
    const session = authenticate(request, config, identityService);
    const query = EventFeedQuerySchema.parse(request.query);
    identityService.authorizeProject(session.actor, query.projectId, "read");
    const afterRevision = reconnectRevision(request, query.afterRevision);
    const normalizedQuery = { ...query, afterRevision };

    if (!acceptsEventStream(request)) {
      return { data: eventFeed.readSince(normalizedQuery) };
    }

    eventFeed.readSince(normalizedQuery);
    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    await streamEvents(request, reply.raw, eventFeed, query.projectId, afterRevision, config);
    return reply;
  });
}
