import type { CSSProperties, HTMLAttributes } from "react";

import { SF_SYMBOL_NAMES, type SfSymbolName, type SfSymbolSize } from "./sf-symbol-names";

const symbolModules = import.meta.glob<string>("./assets/sf-symbols/*.png", {
  eager: true,
  import: "default",
  query: "?url",
});

const SYMBOL_URLS = Object.fromEntries(
  SF_SYMBOL_NAMES.map((name) => [name, symbolModules[`./assets/sf-symbols/${name}.png`]]),
) as Record<SfSymbolName, string>;

export interface SfSymbolProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  label?: string;
  name: SfSymbolName;
  size?: SfSymbolSize;
}

export function SfSymbol({
  "aria-label": ariaLabel,
  className,
  label = ariaLabel,
  name,
  size = 16,
  ...props
}: SfSymbolProps) {
  const symbolUrl = SYMBOL_URLS[name];
  const style: CSSProperties & { "--sf-symbol-size": string } = {
    "--sf-symbol-size": `${size}px`,
    WebkitMaskImage: `url(${symbolUrl})`,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
    backgroundColor: "currentColor",
    maskImage: `url(${symbolUrl})`,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
  };

  return (
    <span
      {...props}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={["sf-symbol", className].filter(Boolean).join(" ")}
      data-sf-symbol={name}
      role={label ? "img" : undefined}
      style={style}
    />
  );
}
