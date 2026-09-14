import { useState } from "react";

export function PersonAvatar({
  person,
}: {
  readonly person:
    { readonly name: string; readonly avatarUrl?: string | null | undefined } | null | undefined;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return person?.avatarUrl && person.avatarUrl !== failedUrl ? (
    <img
      className="assignee-avatar"
      src={person.avatarUrl}
      alt=""
      onError={() => setFailedUrl(person.avatarUrl ?? undefined)}
    />
  ) : (
    <span className="assignee-avatar assignee-avatar--fallback" aria-hidden="true">
      {(person?.name ?? "未").slice(0, 1)}
    </span>
  );
}
