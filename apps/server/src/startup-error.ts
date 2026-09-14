export interface SafeStartupErrorDetails {
  readonly errorName: string;
  readonly systemErrorCode?: string;
}

export function safeStartupErrorDetails(error: unknown): SafeStartupErrorDetails {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? { errorName, systemErrorCode: code }
    : { errorName };
}
