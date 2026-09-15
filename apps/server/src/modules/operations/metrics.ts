import type { RequestMetricsView } from "@codexboard/contracts";

export class RequestMetrics {
  #total = 0;
  #inFlight = 0;
  #errors = 0;

  begin(): void {
    this.#total += 1;
    this.#inFlight += 1;
  }

  finish(statusCode: number): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (statusCode >= 500) this.#errors += 1;
  }

  snapshot(): RequestMetricsView {
    return {
      total: this.#total,
      inFlight: this.#inFlight,
      errors: this.#errors,
    };
  }
}
