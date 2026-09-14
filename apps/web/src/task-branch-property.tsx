import { GitBranch } from "./git-branch-icon";
import { DetailPropertyPicker } from "./detail-property-picker";

export function TaskBranchProperty({
  value,
  label,
  writable,
  options,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly writable: boolean;
  readonly options: readonly { value: string; label: string }[];
  readonly onChange: (value: string) => void;
}) {
  const available = options.some((option) => option.value === value)
    ? options
    : [...options, { value, label }];
  return (
    <div className="detail-property-row">
      <span>分支</span>
      {writable ? (
        <DetailPropertyPicker
          label="分支"
          value={value}
          disabled={false}
          options={available.map((option) => ({ ...option, icon: <GitBranch size={16} /> }))}
          onChange={onChange}
        />
      ) : (
        <span className="detail-branch-value" aria-label="分支" title={label}>
          <GitBranch size={16} />
          <span className="detail-property-text">{label}</span>
        </span>
      )}
    </div>
  );
}
