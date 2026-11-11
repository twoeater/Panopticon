import type { Message } from "../lib/domain.ts";
import { readMentions } from "../lib/mentions.ts";

const EVIDENCE_BUDGET = 4000;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseEvidence(value: unknown): { value: unknown; invalid: boolean } {
  if (typeof value !== "string") return { value, invalid: false };
  try { return { value: JSON.parse(value), invalid: false }; }
  catch { return { value, invalid: true }; }
}

// Stored evidence is untouched. This is a bounded projection for goal prompts only.
export function compactEvidence(message: Pick<Message,"id"|"seq"|"text"|"evidence">) {
  const parsed = parseEvidence(message.evidence);
  if (!parsed.value || (Array.isArray(parsed.value) && !parsed.value.length)) return undefined;
  let truncated = false, visited = 0, unknown = parsed.invalid;
  const clip = (value: unknown, max: number) => {
    if (typeof value !== "string") return undefined;
    if (value.length > max) truncated = true;
    return value.slice(0, max);
  };
  const sources: RecordValue[] = [], executions: RecordValue[] = [];
  const sourceKeys = new Set<string>();
  const walk = (value: unknown, depth = 0) => {
    if (++visited > 2000 || depth > 12) { truncated = true; return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (!record(value)) { if (value !== null && value !== undefined) unknown = true; return; }
    if (value.type === "code") {
      const result = record(value.result) ? value.result : value;
      executions.push({
        language: clip(value.language, 40), code: clip(value.code, 1000),
        ok: typeof result.ok === "boolean" ? result.ok : undefined,
        stdout: clip(result.stdout, 1000), stderr: clip(result.stderr, 1000),
        error: clip(result.error, 500), exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
      });
      return;
    }
    const url = value.url ?? value.uri;
    let isSource = false;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      isSource = true;
      if (url.length > 2048) truncated = true;
      else {
        const source = { url, title: clip(value.title, 180), refId: clip(value.ref_id, 120),
          excerpt: clip(value.snippet ?? value.cited_text ?? value.quote ?? value.description ?? value.text, 600) };
        const key = JSON.stringify(source);
        if (!sourceKeys.has(key)) { sourceKeys.add(key); sources.push(source); }
      }
    }
    let container = false;
    for (const key of ["sources", "results", "annotations", "citations", "content"]) {
      if (value[key] !== undefined) { container = true; walk(value[key], depth + 1); }
    }
    // Usage, search queries, opaque provider payloads and IDs are not evidence text.
    if (!isSource && !container && !["usage", "webSearch", "web_search_call"].includes(String(value.type))) unknown = true;
  };
  walk(parsed.value);
  // Prefer sources explicitly cited in the message over unused search hits.
  const citedUrls = new Set((message.text.match(/https?:\/\/[^\s<>"\])}]+/gi) || []).map(url=>url.replace(/[.,;:!?]+$/, "")));
  sources.sort((a,b)=>Number(citedUrls.has(String(b.url)))-Number(citedUrls.has(String(a.url))));
  const result = {
    representation: "compact", sources: [] as RecordValue[], executions: [] as RecordValue[],
    sourceCount: sources.length, executionCount: executions.length,
    truncated: false, unrecognizedData: unknown,
    raw: { messageId: message.id, seq: message.seq },
  };
  const add = (items: RecordValue[], value: RecordValue) => {
    items.push(value);
    if (JSON.stringify(result).length > EVIDENCE_BUDGET) { items.pop(); truncated = true; }
  };
  for (const execution of executions.slice(0,3)) add(result.executions,execution);
  for (const source of sources.slice(0,8)) add(result.sources,source);
  result.truncated = truncated || result.sources.length < sources.length || result.executions.length < executions.length;
  return result;
}

export function goalMessage(message: Message, rawEvidence = false) {
  return {
    id: message.id, seq: message.seq, phase: message.phase, author: message.author,
    participantId: message.participantId, text: message.text,
    evidence: rawEvidence ? parseEvidence(message.evidence).value : compactEvidence(message),
    mentions: readMentions(message.mentions),
  };
}

export function goalHistoryForModel(value: unknown, rawEvidence: boolean, includedIds: Set<string>): unknown {
  if (!record(value) || !Array.isArray(value.messages)) return value;
  return { ...value, messages: value.messages.map(message => {
    if (!record(message) || typeof message.id !== "string" || typeof message.seq !== "number" || typeof message.text !== "string") return message;
    if (!rawEvidence && includedIds.has(message.id))
      return { messageId: message.id, seq: message.seq, alreadyIncluded: true };
    includedIds.add(message.id);
    return goalMessage(message as unknown as Message, rawEvidence);
  }) };
}
