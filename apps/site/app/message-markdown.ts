"use client";
import { createElement, memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

function messageUrl(url: string): string | undefined {
  if (url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    if (["https:", "http:", "mailto:"].includes(parsed.protocol)) return url;
  } catch { /* Relative paths and malformed URLs remain plain text. */ }
  return undefined;
}

const components: Components = {
  a({ node: _node, href, children, ...props }) {
    if (!href) return createElement("span", null, children);
    const fragment = href.startsWith("#");
    return createElement("a", {
      ...props, href,
      ...(fragment ? {} : { target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" }),
    }, children);
  },
  img({ src, alt }) {
    // Do not load model-supplied remote images or tracking pixels automatically.
    const href = typeof src === "string" ? messageUrl(src) : undefined;
    const label = alt ? `이미지: ${alt}` : "이미지 링크";
    return href
      ? createElement("a", { href, target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" }, label)
      : createElement("span", null, label);
  },
  table({ node: _node, children, ...props }) {
    return createElement("div", { className: "markdown-table-scroll", tabIndex: 0, role: "region", "aria-label": "표" },
      createElement("table", props, children));
  },
  pre({ node: _node, children, ...props }) {
    return createElement("pre", { ...props, tabIndex: 0, "aria-label": "코드 블록" }, children);
  },
};
const plugins = [remarkGfm, remarkBreaks];

export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  messageId,
}: { text: string; messageId: string }) {
  return createElement(Markdown, {
    children: text,
    remarkPlugins: plugins,
    remarkRehypeOptions: {
      clobberPrefix: `message-${encodeURIComponent(messageId)}-`,
      footnoteLabel: "각주",
      footnoteBackLabel: "본문으로 돌아가기",
    },
    components,
    urlTransform: messageUrl,
    // Raw HTML remains escaped text; no HTML execution plugin is enabled.
  });
});
