import { useRef, useState, type SetStateAction } from "react";
import { z } from "zod";
import { RemoteAttachmentSchema, type RemoteModel } from "@codexboard/contracts";
export const DEFAULT_REMOTE_MODEL = "gpt-6-astra";
export const DEFAULT_REMOTE_EFFORT = "medium";
const OptionsSchema = z.object({
  approvalMode: z.enum(["ask", "auto", "full"]).default("auto"),
  model: z.string().default(DEFAULT_REMOTE_MODEL),
  effort: z.string().default(DEFAULT_REMOTE_EFFORT),
  selectionMode: z.enum(["default", "model"]).default("default"),
  serviceTier: z.string().nullable().default(null),
  attachments: z.array(RemoteAttachmentSchema).max(8).default([]),
});
export type ComposerOptions = z.infer<typeof OptionsSchema>;
export function readComposerOptions(saved: string | null): ComposerOptions {
  try {
    const raw = JSON.parse(saved ?? "{}");
    const parsed = OptionsSchema.parse(raw);
    if (
      raw.selectionMode === undefined &&
      (parsed.model !== DEFAULT_REMOTE_MODEL || parsed.effort !== DEFAULT_REMOTE_EFFORT)
    )
      parsed.selectionMode = "model";
    return parsed;
  } catch {
    return OptionsSchema.parse({});
  }
}
// Drafts must outlive the mobile webview. Migrate existing session values once.
export function readRemoteComposerValue(key: string): string | null {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) return saved;
    const legacy = sessionStorage.getItem(key);
    if (legacy !== null) localStorage.setItem(key, legacy);
    return legacy;
  } catch {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }
}
export function writeRemoteComposerValue(key: string, value: string | null) {
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      if (value === null) storage().removeItem(key);
      else storage().setItem(key, value);
    } catch {
      /* Storage restrictions must not freeze the editor. */
    }
  }
}
export function useRemoteDraft(key: string) {
  const [draft, update] = useState(
    () =>
      readRemoteComposerValue(`remote-draft:${key}`) ||
      readRemoteComposerValue(`remote-queue-recovery:${key}`) ||
      "",
  );
  const setDraft = (value: string) => {
    writeRemoteComposerValue(`remote-draft:${key}`, value);
    update(value);
  };
  return [draft, setDraft] as const;
}
export function useRemoteComposerOptions(key: string) {
  const [options, update] = useState<ComposerOptions>(() => {
    const saved = readComposerOptions(readRemoteComposerValue(`remote-options:${key}`));
    if (
      !saved.attachments.length &&
      !readRemoteComposerValue(`remote-draft:${key}`)?.trim() &&
      readRemoteComposerValue(`remote-queue-recovery:${key}`) !== null
    )
      return readComposerOptions(readRemoteComposerValue(`remote-queue-recovery-options:${key}`));
    return saved;
  });
  const current = useRef(options);
  const setOptions = (action: SetStateAction<ComposerOptions>) => {
    const next = typeof action === "function" ? action(current.current) : action;
    current.current = next;
    writeRemoteComposerValue(`remote-options:${key}`, JSON.stringify(next));
    update(next);
  };
  return [options, setOptions] as const;
}

// Desktop recommendation config 423260384, checked 2026-09-10.
// Preserve its order and omit combinations unavailable on the connected host.
export function defaultRemotePresets(models: RemoteModel[]) {
  const pairs = [
    ["gpt-5.6-terra", "low"],
    ["gpt-5.6-sol", "low"],
    ["gpt-5.6-sol", "medium"],
    ["gpt-6-astra", "low"],
    ["gpt-6-astra", "medium"],
    ["gpt-6-astra", "xhigh"],
  ] as const;
  return pairs.flatMap(([model, effort]) =>
    models.some((item) => item.id === model && item.efforts.includes(effort))
      ? [{ model, effort }]
      : [],
  );
}
