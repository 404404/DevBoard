import { identityKey } from "@lark-codex/contracts";
import {
  TEMPORARY_PROJECT_ID,
  type CreateTaskCommand,
  type TaskMutationResult,
} from "@lark-codex/contracts";

import type { CodexThreadProvisioner, ExecutionQueue } from "../execution/index.js";
import type { ProjectRegistry } from "../project-registry/index.js";
import type { MutationContext, Taskboard } from "./taskboard.js";

interface TaskCreationServiceOptions {
  readonly taskboard: Taskboard;
  readonly queue: ExecutionQueue;
  readonly provisioner: CodexThreadProvisioner;
  readonly projectRegistry: Pick<ProjectRegistry, "resolveExecutionContext">;
  readonly codexVersion?: string;
}

export class TaskCreationService {
  readonly #taskboard: Taskboard;
  readonly #queue: ExecutionQueue;
  readonly #provisioner: CodexThreadProvisioner;
  readonly #projectRegistry: Pick<ProjectRegistry, "resolveExecutionContext">;
  readonly #codexVersion: string | undefined;
  readonly #inFlight = new Map<string, Promise<TaskMutationResult>>();

  constructor(options: TaskCreationServiceOptions) {
    this.#taskboard = options.taskboard;
    this.#queue = options.queue;
    this.#provisioner = options.provisioner;
    this.#projectRegistry = options.projectRegistry;
    this.#codexVersion = options.codexVersion;
  }

  create(command: CreateTaskCommand, context: MutationContext): Promise<TaskMutationResult> {
    const key = `${identityKey(context.actor.identity)}:${command.projectId}:${context.idempotencyKey}`;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const creating = this.#create(command, context).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, creating);
    return creating;
  }

  async #create(command: CreateTaskCommand, context: MutationContext): Promise<TaskMutationResult> {
    const created = this.#taskboard.createTask(command, context);
    if (this.#queue.primaryThread(created.task.id)) {
      return { ...created, task: this.#taskboard.readTask(created.task.id, context.actor) };
    }

    let draft: { readonly threadId: string; readonly cwd: string } | undefined;
    try {
      const cwd =
        command.projectId === TEMPORARY_PROJECT_ID
          ? null
          : (
              await this.#projectRegistry.resolveExecutionContext(
                command.projectId,
                command.developmentContextId ?? undefined,
              )
            ).cwd;
      draft = await this.#provisioner.createDraft({
        cwd,
        name: `${created.task.identifier} ${created.task.title}`,
      });
      const bound = this.#queue.bindDraftThread(created.task.id, {
        threadId: draft.threadId,
        cwd: draft.cwd,
        ...(this.#codexVersion ? { codexVersion: this.#codexVersion } : {}),
      });
      return this.#taskboard.finalizeTaskCreation(
        created.task.id,
        bound.revision ?? created.revision,
        context,
      );
    } catch (error: unknown) {
      let archiveError: unknown;
      if (draft) {
        try {
          await this.#provisioner.archiveThread(draft.threadId);
        } catch (caught: unknown) {
          archiveError = caught;
        }
      }
      let rollbackError: unknown;
      try {
        this.#taskboard.rollbackTaskCreation(created.task.id, context);
      } catch (caught: unknown) {
        rollbackError = caught;
      }
      if (archiveError || rollbackError) {
        const errors = [error];
        if (archiveError) errors.push(archiveError);
        if (rollbackError) errors.push(rollbackError);
        const failureDetails = [
          ...(archiveError ? ["新 Thread 无法归档"] : []),
          ...(rollbackError ? ["任务创建无法撤销"] : []),
        ].join("，且");
        throw new AggregateError(
          errors,
          `${draft ? "Codex Thread 绑定失败" : "Codex Thread 创建失败"}，且${failureDetails}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
