export interface Mention { id: string; name: string }
export interface MentionSelection { id: string; start: number; end: number }
type Candidate = { id: string; name: string };

// Drop a selection when its text is edited; keep the others attached to their text.
export function updateMentionSelections(before: string, after: string, selections: readonly MentionSelection[]) {
  let start = 0, suffix = 0;
  while (start < Math.min(before.length,after.length) && before[start] === after[start]) start++;
  while (suffix < Math.min(before.length,after.length)-start && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
  const end = before.length-suffix, delta = after.length-before.length;
  return selections.flatMap(selection => {
    if (selection.end <= start) return [selection];
    if (selection.start >= end) return [{...selection,start:selection.start+delta,end:selection.end+delta}];
    return [];
  });
}

// Keep offsets stable while excluding code examples from invocation syntax.
function prose(text: string) {
  return text.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^`\n]*?(?:\2|$)/g,
    match => match.replace(/[^\n]/g, " "));
}
const boundary = (char: string | undefined) => !char || /[\s,.;:!?()[\]{}<>"'，。！？；：]/u.test(char);
const start = /(^|[\s([{,;:!?])@/gu;

export function resolveMentions(text: string, candidates: readonly Candidate[], preferredIds: readonly string[] = []) {
  const source = prose(text), lower = source.toLowerCase();
  const names = [...new Set(candidates.map(p => p.name.toLowerCase()))].sort((a,b) => b.length-a.length);
  const mentions: Mention[] = [];
  const pattern = new RegExp(start);
  for (let match; (match = pattern.exec(source));) {
    const at = match.index + match[1].length;
    const name = names.find(name => lower.startsWith(name,at+1) && boundary(source[at+1+name.length]));
    if (!name) {
      const token = source.slice(at+1).match(/^[^\s@()[\]{}<>,"'!?;:]+/u)?.[0] || "";
      return { mentions, error: token ? `@${token}: 호출할 AI를 찾을 수 없습니다.` : "@ 뒤에서 호출할 AI를 선택해 주세요." };
    }
    let matches = candidates.filter(p => p.name.toLowerCase() === name);
    if (matches.length > 1) {
      matches = matches.filter(p => preferredIds.includes(p.id));
      if (!matches.length) return {mentions, error:`@${name}: 같은 이름의 AI가 여럿입니다. 목록에서 소유자를 확인하고 선택해 주세요.`};
    }
    for (const p of matches) if (!mentions.some(m=>m.id===p.id)) mentions.push({id:p.id,name:p.name});
    pattern.lastIndex = at + 1 + name.length;
  }
  return {mentions,error:undefined};
}

export function mentionQuery(text: string, caret: number) {
  const source = prose(text).slice(0,caret);
  const at = source.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/[\s([{,;:!?]/u.test(source[at-1]))) return null;
  const query = source.slice(at+1);
  if (query.length > 60 || /[\n@]/u.test(query)) return null;
  return {start:at,end:caret,query:query.toLowerCase()};
}

export function readMentions(value: string | undefined): Mention[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(m=>m && typeof m.id==="string" && typeof m.name==="string") : [];
  } catch { return []; }
}
