import { userErrorMessage } from "./user-error";
import { memo, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { useUiCopy } from "./locale";
import { createUuid } from "./random-id";

const MermaidDiagram = memo(function MermaidDiagram({ source }: { readonly source: string }) {
  const copy = useUiCopy();
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
        const rendered = await mermaid.render(`mermaid-${createUuid()}`, source);
        if (!disposed) setSvg(rendered.svg);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(userErrorMessage(reason, copy.mermaidRenderFailed));
      });
    return () => {
      disposed = true;
    };
  }, [copy.mermaidRenderFailed, source]);

  if (error) return <pre className="markdown-error">{error}</pre>;
  if (!svg) return <div className="markdown-loading">{copy.mermaidRendering}</div>;
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
});

// Stable component types keep polling from unmounting code, links and diagrams
// and changing the scrollable content height during a render.
const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const language = /language-(\w+)/.exec(className ?? "")?.[1];
    const source = String(children).replace(/\n$/, "");
    if (language === "mermaid") return <MermaidDiagram source={source} />;
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

export function MarkdownContent({ markdown }: { readonly markdown: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
