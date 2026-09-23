import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ALL_PROJECT_ID, type CreateMilestoneCommand } from "@codexboard/contracts";

import { createMilestone, listMilestones } from "./api";
import { QueryNotice } from "./query-notice";

function milestoneStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "进行中";
    case "completed":
      return "已完成";
    case "canceled":
      return "已取消";
    default:
      return "计划中";
  }
}

export function ProjectMilestones({
  projectId,
  csrfToken,
  mutationsEnabled,
}: {
  readonly projectId: string;
  readonly csrfToken: string;
  readonly mutationsEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const syntheticProject = projectId === ALL_PROJECT_ID;
  const writable = mutationsEnabled && !syntheticProject;
  const [title, setTitle] = useState("");
  const milestones = useQuery({
    queryKey: ["project-milestones", projectId],
    queryFn: () => listMilestones(projectId),
    enabled: !syntheticProject,
  });
  const create = useMutation({
    mutationFn: (input: Omit<CreateMilestoneCommand, "projectId">) =>
      createMilestone(projectId, input, csrfToken),
    onSuccess: () => {
      setTitle("");
      void queryClient.invalidateQueries({ queryKey: ["project-milestones", projectId] });
    },
  });

  if (syntheticProject) return null;

  return (
    <section className="project-milestones" aria-labelledby="project-milestones-title">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="project-milestones-title">Milestone</h2>
          <p>按项目聚合交付目标与任务完成数</p>
        </div>
      </div>
      {milestones.isPending ? <p>正在加载里程碑…</p> : null}
      {milestones.isError ? (
        <QueryNotice
          error={milestones.error}
          fallback="里程碑暂时无法加载。"
          refreshing={milestones.isFetching}
          onRetry={() => void milestones.refetch()}
        />
      ) : null}
      {milestones.data?.length ? (
        <ul className="project-milestones__list">
          {milestones.data.map((milestone) => (
            <li key={milestone.id}>
              <div>
                <strong>{milestone.title}</strong>
                <small>
                  {milestoneStatusLabel(milestone.status)} · {milestone.completedTaskCount}/{milestone.taskCount} 个任务
                </small>
              </div>
              {milestone.targetDate ? <time dateTime={milestone.targetDate}>{milestone.targetDate}</time> : null}
            </li>
          ))}
        </ul>
      ) : milestones.data ? <p className="project-milestones__empty">还没有 Milestone。</p> : null}
      <form
        className="project-milestones__form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = title.trim();
          if (!value || !writable || create.isPending) return;
          create.mutate({
            title: value,
            description: "",
            status: "planned",
            targetDate: null,
          });
        }}
      >
        <input
          value={title}
          disabled={!writable || create.isPending}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="新建 Milestone"
          aria-label="Milestone 标题"
        />
        <button className="button" type="submit" disabled={!writable || !title.trim() || create.isPending}>
          {create.isPending ? "创建中…" : "添加"}
        </button>
      </form>
    </section>
  );
}
