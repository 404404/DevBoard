import type { ComponentType } from "react";

import { type SfSymbolName } from "./sf-symbol-names";
import { SfSymbol, type SfSymbolProps } from "./sf-symbol";

export type IconProps = Omit<SfSymbolProps, "label" | "name">;

function createIcon(name: SfSymbolName): ComponentType<IconProps> {
  function Icon(props: IconProps) {
    return <SfSymbol {...props} name={name} />;
  }

  Icon.displayName = `SfSymbol(${name})`;
  return Icon;
}

export const AlertTriangle = createIcon("exclamationmark.triangle");
export const ArrowRight = createIcon("arrow.right");
export const ArrowUpToLine = createIcon("arrow.up.to.line");
export const CircleDot = createIcon("smallcircle.filled.circle");
export const Clock3 = createIcon("clock");
export const Ellipsis = createIcon("ellipsis");
export const ExternalLink = createIcon("arrow.up.right.square");
export const FolderKanban = createIcon("folder");
export const GripVertical = createIcon("line.3.horizontal");
export const Image = createIcon("photo");
export const Layers3 = createIcon("square.3.layers.3d");
export const Link = createIcon("link");
export const Link2 = createIcon("link");
export const ListTree = createIcon("list.bullet.indent");
export const LoaderCircle = createIcon("arrow.triangle.2.circlepath");
export const Maximize2 = createIcon("arrow.up.left.and.arrow.down.right");
export const MessageSquare = createIcon("bubble.left");
export const MessageSquareText = createIcon("bubble.left");
export const Paperclip = createIcon("paperclip");
export const Play = createIcon("play.fill");
export const Plus = createIcon("plus");
export const RefreshCw = createIcon("arrow.triangle.2.circlepath");
export const RotateCcw = createIcon("arrow.triangle.2.circlepath");
export const Save = createIcon("tray.and.arrow.down");
export const Search = createIcon("magnifyingglass");
export const ShieldAlert = createIcon("exclamationmark.triangle");
export const Square = createIcon("stop.fill");
export const Tag = createIcon("tag");
export const Tags = createIcon("tag");
export const TerminalSquare = createIcon("apple.terminal");
export const Trash2 = createIcon("trash");
export const UserRound = createIcon("person.crop.circle");
export const Wifi = createIcon("wifi");
export const WifiOff = createIcon("wifi.slash");
export const X = createIcon("xmark");
