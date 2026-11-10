import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../app/message-markdown.ts";

const render = (text: string, messageId = "test") => renderToStaticMarkup(createElement(MessageMarkdown, { text, messageId }));

test("chat markdown renders headings, lists, tables, task lists and preserved line breaks", () => {
  const html = render([
    "## 검증 결과", "", "**강조**와 *기울임*, ~~취소~~", "다음 줄", "",
    "1. 첫 단계", "2. 둘째 단계", "", "- [x] 확인 완료", "- [ ] 추가 검증", "",
    "| 모델 | 결과 |", "| --- | --- |", "| EXAONE | 통과 |", "", "> 인용 근거",
  ].join("\n"));
  for (const pattern of [/<h2>검증 결과<\/h2>/, /<strong>강조<\/strong>/, /<em>기울임<\/em>/, /<del>취소<\/del>/, /<br\/>\n다음 줄/, /<ol>/, /<li>첫 단계<\/li>/, /type="checkbox"/, /disabled=""/, /checked=""/, /class="markdown-table-scroll"/, /<th>모델<\/th>/, /<td>EXAONE<\/td>/, /<blockquote>/]) assert.match(html, pattern);
});

test("fenced and inline code preserve indentation and never execute HTML", () => {
  const html = render('`a < b`\n\n```html\n<div>\n  <script>alert(1)</script>\n</div>\n```');
  assert.match(html, /<code>a &lt; b<\/code>/);
  assert.match(html, /<pre[^>]*><code class="language-html">/);
  assert.match(html, /\n  &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script\b/);
});

test("untrusted message HTML and unsafe links cannot execute or load remote images", () => {
  const html = render([
    '<script>alert("xss")</script>', '', '<img src="https://tracker.example/pixel" onerror="alert(1)">', '',
    '[bad](javascript:alert%281%29)', '[file](file:///etc/passwd)', '[data](data:text/html,payload)',
    '[relative](/signout-with-chatgpt)', '', '![diagram](https://images.example/diagram.png)',
  ].join('\n'));
  assert.doesNotMatch(html, /<(?:script|img|iframe)\b/i);
  assert.doesNotMatch(html, /href="(?:javascript:|file:|data:|\/signout)/i);
  assert.match(html, /href="https:\/\/images.example\/diagram.png"/);
  assert.match(html, /이미지: diagram/);
});

test("safe and bare links retain their URLs and footnotes stay within each message", () => {
  const html = render('[출처](https://example.com/evidence)\nhttps://example.com/bare', 'one');
  assert.match(html, /href="https:\/\/example.com\/evidence"/);
  assert.match(html, /href="https:\/\/example.com\/bare"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  const first = render('주장[^1]\n\n[^1]: 첫 근거', 'one');
  const second = render('주장[^1]\n\n[^1]: 다른 근거', 'two');
  assert.match(first, /href="#message-one-fn-1"/);
  assert.match(second, /href="#message-two-fn-1"/);
  assert.doesNotMatch(second, /message-one-/);
});
