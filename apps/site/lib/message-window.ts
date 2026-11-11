import type { Message } from "./domain.ts";
export function mergeMessageWindow(previous: Message[], incoming: Message[], limit=300): Message[] {
  const prior=new Map(previous.map(m=>[m.id,m]));
  const gap=incoming.length===100 && previous.length>0 && incoming[0].seq>previous[previous.length-1].seq;
  const merged=new Map((gap?[]:previous).map(m=>[m.id,m]));
  for(const message of incoming) {
    const old=prior.get(message.id);
    merged.set(message.id,old&&JSON.stringify(old)===JSON.stringify(message)?old:message);
  }
  return [...merged.values()].sort((a,b)=>a.seq-b.seq).slice(-limit);
}
