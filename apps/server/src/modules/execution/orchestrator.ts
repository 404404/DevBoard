import type { JobView } from "@lark-codex/contracts";

import { CodexProtocolError, CodexRequestError, type CodexServerRequest } from "../codex/index.js";
import {
  CodexDisconnectedError,
  type CodexExecutor,
  type CodexExecutionCallbacks,
} from "./codex-executor.js";
import type { ExecutionQueue, JobClaimScope } from "./execution-queue.js";
import type { InteractionService } from "./interaction-service.js";
import { isModelAtCapacity } from "./model-capacity.js";

interface ExecutionOrchestratorOptions {
  readonly queue: ExecutionQueue;
  readonly executor: CodexExecutor;
  readonly interactions: InteractionService;
  readonly owner: string;
  readonly codexVersion?: string;
}

export class ExecutionOrchestrator {
  readonly #queue: ExecutionQueue;
  readonly #executor: CodexExecutor;
  readonly #interactions: InteractionService;
  readonly #owner: string;
  readonly #codexVersion: string | undefined;
  #stopping = false;

  constructor(options: ExecutionOrchestratorOptions) {
    this.#queue = options.queue;
    this.#executor = options.executor;
    this.#interactions = options.interactions;
    this.#owner = options.owner;
    this.#codexVersion = options.codexVersion;
  }

  stop(): void {
    this.#stopping = true;
  }

  #assertRunning(): void {
    if (this.#stopping) throw new Error("执行调度正在停止");
  }

  async runNext(scope: JobClaimScope = "any"): Promise<JobView | null> {
    if (this.#stopping) return null;
    const job = this.#queue.claimNext(this.#owner, scope);
    if (!job) return null;
    try {
      if (job.kind === "cancel") return await this.#cancel(job);
      return await this.#execute(job);
    } catch (error: unknown) {
      if (this.#stopping) return null;
      const current = this.#queue.readJob(job.id);
      if (["running", "waiting_approval", "waiting_input"].includes(current.status)) {
        if (job.kind === "cancel") {
          if (job.targetJobId) this.#interactions.cancelForJob(job.targetJobId);
          return this.#queue.failCancellation(
            job.id,
            this.#owner,
            error instanceof CodexDisconnectedError
              ? "CONNECTOR_DISCONNECTED"
              : "CANCEL_INTERRUPTION_FAILED",
            error instanceof CodexDisconnectedError
              ? "Codex App Server 连接已中断"
              : "取消指令未确认送达",
          ).cancel;
        }
        if (error instanceof CodexRequestError && isModelAtCapacity(error.message)) {
          this.#interactions.cancelForJob(job.id);
          return this.#queue.holdForModelCapacity(job.id, this.#owner);
        }
        if (
          current.recoveryCheckpoint?.dispatchState === "not_sent" &&
          (error instanceof CodexDisconnectedError || error instanceof CodexProtocolError)
        ) {
          return this.#queue.releaseForRetry(
            job.id,
            this.#owner,
            "CODEX_NOT_ACCEPTED",
            "连接准备失败，已确认尚未发送执行指令",
          );
        }
        if (error instanceof CodexDisconnectedError) {
          this.#interactions.expirePending("Codex App Server 连接已中断");
          return this.#queue.holdUncertain(
            job.id,
            this.#owner,
            "CONNECTOR_DISCONNECTED",
            "Codex App Server 连接已中断",
          );
        }
        if (error instanceof CodexProtocolError) {
          return this.#queue.holdUncertain(
            job.id,
            this.#owner,
            "CODEX_OUTCOME_UNKNOWN",
            "Codex 响应未确认，需先核对远端状态",
          );
        }
        if (error instanceof CodexRequestError) {
          const desktopErrors: Record<number, readonly [string, string]> = {
            [-32001]: [
              "CODEX_DESKTOP_UNAVAILABLE",
              "无法连接此对话的 Codex 桌面所有者，请打开原对话后再继续",
            ],
            [-32002]: ["CODEX_THREAD_BUSY", "Codex 对话正在执行，请等待当前回合结束"],
            [-32003]: [
              "CODEX_OUTCOME_UNKNOWN",
              "Codex 桌面连接中断或响应超时，执行结果尚未确认；请先查看原对话，避免重复执行",
            ],
          };
          const diagnostic = desktopErrors[error.code];
          if (diagnostic) {
            this.#interactions.cancelForJob(job.id);
            if (error.code === -32002)
              return this.#queue.releaseForRetry(job.id, this.#owner, ...diagnostic);
            return error.code === -32003
              ? this.#queue.holdUncertain(job.id, this.#owner, ...diagnostic)
              : this.#queue.fail(job.id, this.#owner, ...diagnostic);
          }
        }
        return this.#queue.fail(job.id, this.#owner, "CODEX_EXECUTION_FAILED", "Codex 执行失败");
      }
      return current;
    }
  }

  async #execute(job: JobView): Promise<JobView> {
    const cwd = String(job.workContext.cwd ?? "");
    const prompt = String(job.workContext.prompt ?? "");
    if (!cwd || !prompt) throw new Error("执行作业缺少已解析的工作目录或提示词");
    const callbacks: CodexExecutionCallbacks = {
      onDispatchState: (state) => {
        this.#assertRunning();
        this.#queue.recordDispatchState(job.id, this.#owner, state);
      },
      onThread: (threadId) => {
        this.#assertRunning();
        if (job.kind === "start") {
          this.#queue.bindThread(job.id, this.#owner, {
            threadId,
            cwd,
            ...(this.#codexVersion ? { codexVersion: this.#codexVersion } : {}),
          });
          return;
        }
        if (this.#queue.primaryThread(job.taskId)?.threadId !== threadId) {
          throw new Error("Codex 返回了非预期主 Thread");
        }
      },
      onTurn: (turnId) => {
        this.#assertRunning();
        this.#queue.recordTurn(job.id, this.#owner, turnId);
      },
      onEvent: (event) => {
        if (this.#stopping) return;
        const activeStatuses = ["running", "waiting_approval", "waiting_input"];
        if (!activeStatuses.includes(this.#queue.readJob(job.id).status)) return;
        try {
          this.#queue.appendExecutionEvent(job.id, this.#owner, event);
        } catch (error: unknown) {
          if (!activeStatuses.includes(this.#queue.readJob(job.id).status)) return;
          throw error;
        }
      },
      onInteraction: (request: CodexServerRequest) => this.#handleInteraction(job, request),
    };
    let result;
    await this.#queue.captureWorkspaceStart(job.id);
    this.#assertRunning();
    const beforeDispatch = this.#queue.readJob(job.id);
    if (beforeDispatch.status === "canceling")
      return this.#queue.confirmCancellationBeforeDispatch(job.id, this.#owner);
    if (beforeDispatch.status !== "running") return beforeDispatch;
    // Older/custom adapters do not report dispatch phases. Once invoked, treat
    // their outcome as unknown unless the adapter supplies stronger evidence.
    callbacks.onDispatchState?.("sent");
    if (job.kind === "start" && !this.#queue.primaryThread(job.taskId)) {
      result = await this.#executor.start({ jobId: job.id, cwd, prompt }, callbacks);
    } else {
      const thread = this.#queue.primaryThread(job.taskId);
      if (!thread || (job.taskThreadId && job.taskThreadId !== thread.id)) {
        throw new Error("任务没有可继续的主 Thread");
      }
      this.#queue.bindExistingThread(job.id, this.#owner, thread.id);
      result = await this.#executor.continue(
        {
          jobId: job.id,
          threadId: thread.threadId,
          cwd,
          prompt,
        },
        callbacks,
      );
    }
    this.#assertRunning();
    await this.#queue.captureWorkspaceStop(job.id);
    this.#assertRunning();
    if (this.#queue.readJob(job.id).status === "canceling") {
      return this.#queue.confirmCancellationFromExecution(job.id, this.#owner, result.turnId);
    }
    if (result.status === "completed") {
      return this.#queue.succeedAndRequestReview(job.id, this.#owner, { turnId: result.turnId });
    }
    if (isModelAtCapacity(result.errorSummary)) {
      this.#interactions.cancelForJob(job.id);
      return this.#queue.holdForModelCapacity(job.id, this.#owner);
    }
    if (result.status === "interrupted") {
      return this.#queue.fail(job.id, this.#owner, "TURN_INTERRUPTED", "Codex Turn 已中断");
    }
    return this.#queue.fail(job.id, this.#owner, "TURN_FAILED", "Codex Turn 执行失败");
  }

  async #handleInteraction(job: JobView, request: CodexServerRequest) {
    this.#assertRunning();
    const pending = this.#interactions.open(job.id, this.#owner, {
      id: request.id,
      method: request.method,
      params: request.params,
    });
    const decision = await pending.decision;
    if (!this.#stopping) this.#interactions.markDelivered(pending.interaction.id, this.#owner);
    return decision;
  }

  async #cancel(cancelJob: JobView): Promise<JobView> {
    if (!cancelJob.targetJobId) throw new Error("取消作业缺少目标");
    const target = this.#queue.readJob(cancelJob.targetJobId);
    const thread = this.#queue.primaryThread(target.taskId);
    let turnId = target.recoveryCheckpoint?.turnId;
    if (typeof turnId !== "string") {
      if (target.recoveryCheckpoint?.dispatchState === "not_sent") {
        return this.#queue.completeCancellation(cancelJob.id, this.#owner).cancel;
      }
      if (!thread || !this.#executor.reconcile)
        throw new Error("目标作业尚未确认当前 Turn，保留占用等待核对");
      const result = await this.#executor.reconcile({
        jobId: target.id,
        threadId: thread.threadId,
        cwd: String(target.workContext.cwd ?? thread.cwd),
      });
      this.#assertRunning();
      if (result.status === "unknown") throw new Error("远端未提供当前消息的接受或停止证据");
      turnId = result.turnId;
      this.#queue.recordReconciledTurn(cancelJob.id, this.#owner, turnId);
      if (result.status === "stopped") {
        await this.#queue.captureWorkspaceStop(target.id);
        this.#assertRunning();
        return this.#queue.completeCancellation(cancelJob.id, this.#owner).cancel;
      }
    }
    if (!thread) throw new Error("目标作业尚未绑定 Thread");
    await this.#executor.interrupt(thread.threadId, turnId);
    this.#assertRunning();
    await this.#queue.captureWorkspaceStop(target.id);
    this.#assertRunning();
    this.#interactions.cancelForJob(target.id);
    return this.#queue.completeCancellation(cancelJob.id, this.#owner).cancel;
  }
}
