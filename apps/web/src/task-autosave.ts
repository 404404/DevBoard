import {
  sameIdentity,
  UserIdentityRefSchema,
  type UserIdentityRef,
  type TaskView,
} from "@lark-codex/contracts";

export const EDITABLE_TASK_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "assigneeIdentity",
  "developmentContextId",
  "labels",
  "links",
] as const;
export type EditableTaskField = (typeof EDITABLE_TASK_FIELDS)[number];
export type TaskDraft = Pick<TaskView, EditableTaskField>;
export type TaskDraftPatch = Partial<Omit<TaskDraft, "assigneeIdentity">> & {
  assigneeIdentity?: UserIdentityRef | null;
};
type Persist = (task: TaskView, patch: TaskDraftPatch) => Promise<TaskView>;

class DraftValidationError extends Error {}

function equal(
  field: EditableTaskField,
  left: TaskDraft[EditableTaskField],
  right: TaskDraft[EditableTaskField],
): boolean {
  if (field === "assigneeIdentity") {
    return sameIdentity(
      left as TaskDraft["assigneeIdentity"],
      right as TaskDraft["assigneeIdentity"],
    );
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function draftOf(task: TaskView): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeIdentity: task.assigneeIdentity,
    developmentContextId: task.developmentContextId,
    labels: [...task.labels],
    links: [...task.links],
  };
}

interface SaveSnapshot {
  readonly task: TaskView;
  readonly draft: TaskDraft;
  readonly pending: boolean;
  readonly dirty: boolean;
  readonly error: Error | undefined;
}

/** One request at a time; drafts and committed values have separate lifetimes. */
export class TaskAutosave {
  private snapshot: SaveSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly queued = new Map<EditableTaskField, TaskDraft[EditableTaskField]>();
  private running: Promise<void> | undefined;
  private enabled = true;

  constructor(
    task: TaskView,
    private readonly persist: Persist,
  ) {
    this.snapshot = { task, draft: draftOf(task), pending: false, dirty: false, error: undefined };
  }

  getSnapshot = (): SaveSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(change: Partial<SaveSnapshot>) {
    const next = { ...this.snapshot, ...change };
    this.snapshot = {
      ...next,
      dirty: EDITABLE_TASK_FIELDS.some((key) => !equal(key, next.draft[key], next.task[key])),
    };
    this.listeners.forEach((listener) => listener());
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) void this.flush();
  }

  edit(patch: TaskDraftPatch) {
    this.publish({
      draft: { ...this.snapshot.draft, ...patch },
      ...(this.snapshot.error instanceof DraftValidationError && patch.title?.trim()
        ? { error: undefined }
        : {}),
    });
  }

  cancel(field: EditableTaskField) {
    this.queued.delete(field);
    this.edit({ [field]: this.snapshot.task[field] });
  }

  receive(task: TaskView) {
    if (
      task.version <= this.snapshot.task.version ||
      this.snapshot.dirty ||
      this.snapshot.pending ||
      this.snapshot.error
    )
      return;
    this.reset(task);
  }

  reset(task: TaskView) {
    if (this.snapshot.pending) return;
    this.queued.clear();
    this.publish({ task, draft: draftOf(task), error: undefined });
  }

  commit(field: EditableTaskField) {
    const value = this.snapshot.draft[field];
    if (field === "title" && !String(value).trim()) {
      if (!this.snapshot.error || this.snapshot.error instanceof DraftValidationError) {
        this.publish({ error: new DraftValidationError("标题不能为空。") });
      }
      return;
    }
    // Also enqueue a return to the original value while an older value is in flight.
    if (!equal(field, value, this.snapshot.task[field]) || this.snapshot.pending)
      this.queued.set(field, value);
    void this.flush();
  }

  async retry() {
    if (!this.snapshot.draft.title.trim()) return;
    this.queued.clear();
    this.publish({ error: undefined });
    for (const field of EDITABLE_TASK_FIELDS) {
      if (!equal(field, this.snapshot.draft[field], this.snapshot.task[field]))
        this.queued.set(field, this.snapshot.draft[field]);
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.snapshot.error || !this.enabled || this.queued.size === 0) return;
    this.running = this.drain();
    await this.running;
    this.running = undefined;
  }

  private async drain() {
    this.publish({ pending: true });
    while (this.queued.size > 0 && this.enabled && !this.snapshot.error) {
      const [field, value] = this.queued.entries().next().value!;
      this.queued.delete(field);
      if (equal(field, value, this.snapshot.task[field])) continue;
      try {
        const patch: TaskDraftPatch =
          field === "assigneeIdentity"
            ? { assigneeIdentity: UserIdentityRefSchema.nullable().parse(value) }
            : { [field]: value };
        const updated = await this.persist(this.snapshot.task, patch);
        const draft = { ...this.snapshot.draft };
        if (equal(field, draft[field], value)) Object.assign(draft, { [field]: updated[field] });
        this.publish({ task: updated, draft });
      } catch (error) {
        if (!this.queued.has(field)) this.queued.set(field, value);
        this.publish({ error: error instanceof Error ? error : new Error("保存失败，请重试。") });
      }
    }
    this.publish({ pending: false });
  }
}
