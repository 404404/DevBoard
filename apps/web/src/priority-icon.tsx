import type { TaskPriority } from "@codexboard/contracts";
import { priorityBarStates } from "./task-create-model";

export function PriorityIcon({
  priority,
  className = "",
}: {
  readonly priority: TaskPriority;
  readonly className?: string;
}) {
  if (priority === "urgent") {
    return (
      <span className={`priority-urgent-icon ${className}`} aria-hidden="true">
        !
      </span>
    );
  }
  if (priority === "none") {
    return (
      <span className={`priority-none-icon ${className}`} aria-hidden="true">
        ---
      </span>
    );
  }
  const states = priorityBarStates(priority);
  return (
    <span
      className={`priority-bars ${className}`}
      aria-hidden="true"
      data-sf-symbol="chart.bar.fill"
    >
      {states.map((active, index) => (
        <i key={index} data-active={active || undefined} />
      ))}
    </span>
  );
}
