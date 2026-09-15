import {
  UserIdentityRefSchema,
  identityFromKey,
  sameIdentity,
  type UserIdentityRef,
  type IdentityRef,
  type TaskAssigneeCandidate,
} from "@codexboard/contracts";

export function currentAssignee(
  candidates: readonly TaskAssigneeCandidate[],
  identity: IdentityRef | undefined,
): TaskAssigneeCandidate | undefined {
  return candidates.find((candidate) => sameIdentity(candidate.identity, identity));
}

/** Picker keys stay in the UI; API payloads always receive a structured Feishu identity. */
export function assigneeFromSelection(value: string): UserIdentityRef | null {
  return value === "" ? null : UserIdentityRefSchema.parse(identityFromKey(value));
}
