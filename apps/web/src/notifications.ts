export type NotificationTone = "success" | "error" | "info";
interface Notification {
  readonly id: string;
  readonly message: string;
  readonly tone: NotificationTone;
}

let items: readonly Notification[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const deadlines = new Map<string, number>();
const remaining = new Map<string, number>();
const emit = () => listeners.forEach((listener) => listener());

export const notifications = {
  getSnapshot: () => items,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  pause(id: string) {
    const deadline = deadlines.get(id);
    if (deadline === undefined || remaining.has(id)) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    remaining.set(id, Math.max(0, deadline - Date.now()));
  },
  resume(id: string) {
    const duration = remaining.get(id);
    if (duration === undefined) return;
    remaining.delete(id);
    schedule(id, duration);
  },
  dismiss(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    deadlines.delete(id);
    remaining.delete(id);
    items = items.filter((item) => item.id !== id);
    emit();
  },
};

export function notify(
  message: string,
  tone: NotificationTone = "info",
  id = `notice-${++sequence}`,
) {
  if (!message.trim()) return;
  clearTimeout(timers.get(id));
  items = [...items.filter((item) => item.id !== id), { id, message, tone }];
  while (items.length > 3) notifications.dismiss(items[0]!.id);
  if (remaining.has(id)) remaining.set(id, 1_000);
  else schedule(id, 1_000);
  emit();
}

function schedule(id: string, duration: number) {
  deadlines.set(id, Date.now() + duration);
  timers.set(
    id,
    setTimeout(() => notifications.dismiss(id), duration),
  );
}
