import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import dockerfile from "highlight.js/lib/languages/dockerfile";

for (const [name, language] of Object.entries({
  typescript,
  javascript,
  css,
  json,
  bash,
  python,
  xml,
  yaml,
  dockerfile,
}))
  hljs.registerLanguage(name, language);
const languages: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  css: "css",
  json: "json",
  sh: "bash",
  zsh: "bash",
  py: "python",
  html: "xml",
  svg: "xml",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  dockerfile: "dockerfile",
};
export function highlightReviewLine(text: string, path: string) {
  const language = languages[path.split(/[/.]/).at(-1)?.toLowerCase() ?? ""];
  if (!language) return null;
  // The highlighter escapes source text before adding its own token spans.
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
