import type { Channel, Message } from "./domain.ts";
export function reconcileMessageWindow(previous: Message[], incoming: Message[], oldChannel: Channel, channel: Channel, readingHistory=false): Message[] {
  if ((channel.historyRevision ?? 0) < (oldChannel.historyRevision ?? 0)) return previous;
  const reset = (channel.historyRevision ?? 0) !== (oldChannel.historyRevision ?? 0);
  const cutoff = Math.max(channel.generalPrunedThrough ?? 0, oldChannel.generalPrunedThrough ?? 0);
  const retained = (m: Message) => Boolean(m.goalId) || m.seq > cutoff;
  if (readingHistory && !reset) return previous.filter(retained);
  return mergeMessageWindow(reset ? [] : previous.filter(retained), incoming.filter(retained));
}
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
