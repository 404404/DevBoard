import type { SVGProps } from "react";

export function GitBranch({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon="git-branch"
      aria-hidden="true"
      style={{ flexShrink: 0, ...props.style }}
    >
      <path d="M6 7.5v9M18 7.5v1a6 6 0 0 1-6 6H6" />
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
    </svg>
  );
}
