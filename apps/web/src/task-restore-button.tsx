import { userErrorMessage } from "./user-error";
import { Notice } from "./notification-center";
import type { TaskView } from "@codexboard/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { restoreTask } from "./api";
import { applyTaskUpdate } from "./task-move-cache";
import { notify } from "./notifications";
import { createUuid } from "./random-id";

export function TaskRestoreButton({
  task,
  csrfToken,
  enabled = true,
}: {
  readonly task: TaskView;
  readonly csrfToken: string;
  readonly enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => restoreTask(task.id, task.version, csrfToken, createUuid()),
    onSuccess(updated) {
      notify("任务已恢复", "success");
      applyTaskUpdate(queryClient, updated);
      for (const key of [["board"], ["dashboard"], ["workspace", task.id], ["lifecycle", task.id]])
        void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <>
      <button
        type="button"
        className="button"
        disabled={!enabled || mutation.isPending}
        onClick={() => mutation.mutate()}
        aria-label={`恢复任务 ${task.identifier}`}
      >
        {mutation.isPending ? "正在恢复…" : "恢复任务"}
      </button>
      {mutation.isError && (
        <Notice message={userErrorMessage(mutation.error)} eventKey={mutation.error} />
      )}
    </>
  );
}
