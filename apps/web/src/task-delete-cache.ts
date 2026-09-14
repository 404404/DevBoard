import type { QueryClient } from "@tanstack/react-query";

export async function invalidateTaskDeletionQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["board"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  ]);
}
