import type { CSSProperties } from "react";

// Match the Remote dial: medium points straight up; higher settings advance
// clockwise. Keep the arc and needle on the same angular scale.
const angles: Record<string, number> = {
  none: -120,
  minimal: -90,
  low: -60,
  medium: 0,
  high: 30,
  xhigh: 60,
  max: 90,
  ultra: 120,
};
export function RemoteEffortGauge({ effort }: { effort: string | undefined }) {
  const knownAngle = angles[effort ?? ""];
  const angle = knownAngle ?? 0;
  return (
    <svg
      className="remote-effort-gauge"
      viewBox="0 0 32 32"
      aria-hidden="true"
      data-effort={effort ?? "unknown"}
      style={{ "--gauge-angle": `${angle}deg` } as CSSProperties}
    >
      <path className="remote-gauge-track" d="M5.608 24 A12 12 0 1 1 26.392 24" />
      <path
        className="remote-gauge-fill"
        d="M5.608 24 A12 12 0 1 1 26.392 24"
        pathLength="100"
        strokeDasharray="100 100"
        strokeDashoffset={knownAngle === undefined ? 100 : 100 - ((angle + 120) / 240) * 100}
      />
      <g className="remote-gauge-needle">
        <path d="M16 15 V8" />
      </g>
      <circle cx="16" cy="18" r="2.6" />
    </svg>
  );
}
