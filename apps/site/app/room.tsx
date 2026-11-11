"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  ArrowUp,
  Copy,
  Settings2,
  Pause,
  Play,
  X,
  Link2,
  Check,
  LogOut,
  ShieldCheck,
  Radio,
  MessageSquare,
  Menu,
} from "lucide-react";
import type { Channel, Participant, Message, Job, Round } from "../lib/domain";
import { MessageMarkdown } from "./message-markdown";
import { GoalCenter, goalPhaseLabels } from "./goal-center";
import { mergeMessageWindow } from "../lib/message-window";
import type { GoalSummary } from "../lib/domain";
import { mentionQuery, readMentions, resolveMentions, updateMentionSelections, type MentionSelection } from "../lib/mentions";
type Snapshot = {
  activeGoal: GoalSummary | null;
  channel: Channel;
  messages: Message[];
  participants: Participant[];
  members: { userId: string; name: string }[];
  rounds: Round[];
  jobs: Job[];
  serverTime: number;
};
const phases: Record<string, string> = {
  ...goalPhaseLabels,
  chat: "독립 답변",
  review: "상호 검토",
  revise: "수정·재반박",
  summary: "쟁점 정리",
  heartbeat: "자동 대화",
  external: "MCP 참여",
};
const colors: Record<string, string> = {
  openai: "#93c5fd",
  anthropic: "#fdba74",
  grok: "#d4d4d4",
  exaone: "#f9a8d4",
  "openai-compatible": "#c4b5fd",
  external: "#a5b4fc",
};
const providerSymbols: Record<string, string> = {
  openai: "◎", anthropic: "✳", grok: "𝕏", exaone: "E", "openai-compatible": "◇",
};
async function api(
  action: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const res = await fetch("/api/room", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error || "요청 실패");
  return data;
}
export default function ChatRoom({
  user,
}: {
  user: { id: string; name: string };
}) {
  const [channels, setChannels] = useState<Channel[]>([]),
    [devices, setDevices] = useState<
      { id: string; name: string; revoked: number }[]
    >([]),
    [selected, setSelected] = useState(""),
    [data, setData] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState(""),
    [goalView,setGoalView]=useState<string|null>(null),
    [goalTarget,setGoalTarget]=useState(""),
    [readingHistory,setReadingHistory]=useState(false),
    [caret, setCaret] = useState(0),
    [preferredTargets, setPreferredTargets] = useState<MentionSelection[]>([]),
    [mentionIndex, setMentionIndex] = useState(0),
    [mentionDismissed, setMentionDismissed] = useState(false),
    [reply, setReply] = useState<Message | null>(null),
    [verify, setVerify] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(true),
    [sidebar, setSidebar] = useState(false),
    [showDetails, setShowDetails] = useState(false),
    [oldestReached, setOldestReached] = useState(false);
  const [modal, setModal] = useState<
      "create" | "join" | "connect" | "settings" | null
    >(null),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [joinId, setJoinId] = useState(""),
    [code, setCode] = useState(""),
    [situation, setSituation] = useState(""),
    [seconds, setSeconds] = useState(180),
    [heartbeat, setHeartbeat] = useState(true),
    [heartbeatParticipants, setHeartbeatParticipants] = useState(3),
    [heartbeatAll, setHeartbeatAll] = useState(false),
    [goalSummaryParticipantId, setGoalSummaryParticipantId] = useState(""),
    [copied, setCopied] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null),
    readingHistoryRef=useRef(false),
    list = useRef<HTMLDivElement>(null),
    end = useRef<HTMLDivElement>(null),
    selectedRef = useRef(selected),
    pending = useRef<{ id: string; text: string; channel: string; optionsKey: string } | null>(
      null,
    );
  selectedRef.current = selected;
  const bootstrap = useCallback(async () => {
    const r = await api("bootstrap");
    setChannels(r.channels);
    setDevices(r.devices);
    setSelected((old) =>
      r.channels.some((c: Channel) => c.id === old)
        ? old
        : r.channels[0]?.id || "",
    );
  }, []);
  const refresh = useCallback(async () => {
    if (!selected) return;
    const r = await api("snapshot", { channelId: selected });
    if (selectedRef.current !== selected) return;
    const bottom =
      !list.current ||
      list.current.scrollHeight -
        list.current.scrollTop -
        list.current.clientHeight <
        160;
    setData(old => old && old.channel.id === r.channel.id ? {...r, messages: readingHistoryRef.current ? old.messages : mergeMessageWindow(old.messages,r.messages)} : r);
    setConnected(true);
    if (bottom && !readingHistoryRef.current)
      setTimeout(
        () => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }),
        20,
      );
  }, [selected]);
  useEffect(() => {
    bootstrap().catch((e) => setError(e.message));
  }, [bootstrap]);
  useEffect(() => {
    setData(null);
    setOldestReached(false);
    setShowDetails(false);
    setReply(null);
    readingHistoryRef.current=false;setReadingHistory(false);setGoalTarget("");setGoalView(null);
    setPreferredTargets([]);
    setMentionDismissed(true);
    refresh().catch((e) => setError(e.message));
    const t = setInterval(
      () => refresh().catch(() => setConnected(false)),
      2500,
    );
    return () => clearInterval(t);
  }, [refresh]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const loadOlder = () => act(async () => {
    if (!data?.messages.length) return;
    const current = selected;
    const r: Snapshot = await api('snapshot', {channelId: current, before: data.messages[0].seq});
    if (selectedRef.current !== current) return;
    setOldestReached(r.messages.length < 100);
    if(!r.messages.length)return;
    readingHistoryRef.current=true;setReadingHistory(true);
    setData(old => old ? {...old, messages:r.messages} : old);
    requestAnimationFrame(() => { if(list.current) list.current.scrollTop=0; });
  });
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("복사하지 못했습니다. 텍스트를 직접 선택해 주세요.");
    }
  };
  const open = (m: typeof modal) => {
    setModal(m);
    setError("");
    setName("");
    setPassword("");
    setJoinId("");
    setCode("");
    if (data) {
      setSituation(data.channel.situation);
      setSeconds(data.channel.heartbeatSeconds);
      setHeartbeat(Boolean(data.channel.heartbeatEnabled));
      setHeartbeatParticipants(data.channel.heartbeatParticipants || 3);
      setHeartbeatAll(data.channel.heartbeatParticipants === 0);
      setGoalSummaryParticipantId(data.channel.goalSummaryParticipantId || "");
    }
  };
  const send = () =>
    act(async () => {
      if (!draft.trim() || !selected) return;
      if (addressed.error) throw new Error(addressed.error);
      const text = draft.trim();
      const targets = addressed.mentions.map(m=>m.id);
      const optionsKey = JSON.stringify({targets,verify,replyTo:reply?.id,goalTarget});
      const nonce =
        pending.current?.text === text && pending.current.channel === selected && pending.current.optionsKey === optionsKey
          ? pending.current.id
          : crypto.randomUUID();
      pending.current = { id: nonce, text, channel: selected, optionsKey };
      await api("message_post", {
        channelId: selected,
        text,
        clientMessageId: nonce,
        replyTo: reply?.id,
        verify:!goalTarget&&verify,
        goalId:goalTarget||undefined,
        targetParticipantIds: targets,
      });
      pending.current = null;
      setDraft("");
      setPreferredTargets([]);
      setCaret(0);
      setReply(null);
      setVerify(false);
      await refresh();
    });
  const channel = data?.channel,
    owner = channel?.ownerId === user.id,
    online =
      data?.participants.filter((p) => p.onlineAt > data.serverTime - 30000) ||
      [],
    active = data?.rounds.find((r) => r.status === "active");
  const candidates = data?.participants.filter(p=>p.deviceId!=="mcp") || [];
  const addressed = goalTarget?{mentions:[],error:undefined}:resolveMentions(draft,candidates,preferredTargets.map(target=>target.id));
  const query = mentionDismissed || goalTarget ? null : mentionQuery(draft,caret);
  const suggestions = query ? candidates.filter(p=>p.name.toLowerCase().startsWith(query.query)).slice(0,8) : [];
  const selectedSuggestion = Math.min(mentionIndex,Math.max(suggestions.length-1,0));
  const ownerLabel = (p: Participant) => p.ownerId===user.id ? "나" : data?.members.find(m=>m.userId===p.ownerId)?.name || "다른 사용자";
  const chooseMention = (p: Participant) => {
    if (!query) return;
    const insertion = `@${p.name} `;
    const next = draft.slice(0,query.start)+insertion+draft.slice(query.end);
    const position = query.start+insertion.length;
    setDraft(next);
    setPreferredTargets(old=>[...updateMentionSelections(draft,next,old),{id:p.id,start:query.start,end:position-1}]);
    setCaret(position);
    setMentionIndex(0);
    setMentionDismissed(true);
    requestAnimationFrame(()=>{composer.current?.focus();composer.current?.setSelectionRange(position,position);});
  };
  const beginMention = () => {
    const position = composer.current?.selectionStart ?? draft.length;
    const insertion = `${position && !/\s/.test(draft[position-1]) ? " " : ""}@`;
    const next = draft.slice(0,position)+insertion+draft.slice(position);
    setPreferredTargets(old=>updateMentionSelections(draft,next,old));
    setDraft(next);
    setCaret(position+insertion.length);
    setMentionIndex(0);
    setMentionDismissed(false);
    requestAnimationFrame(()=>{composer.current?.focus();composer.current?.setSelectionRange(position+insertion.length,position+insertion.length);});
  };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? "mobile-open" : ""}`}>
        <a className="brand" href="/">
          <span className="eyemark">◎</span>
          <span>
            PANOPTICON<small>다중 지성 관측실</small>
          </span>
        </a>
        <div className="workspace-label">
          YOUR CHANNELS
          <button aria-label="채널 만들기" onClick={() => open("create")}>
            <Plus size={16} />
          </button>
        </div>
        <nav>
          {channels.map((c) => (
            <button
              key={c.id}
              className={`channel-button ${selected === c.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(c.id);
                setSidebar(false);
              }}
            >
              <span className="hash">#</span>
              {c.name}
              {selected === c.id && <i className="dot" />}
            </button>
          ))}
        </nav>
        <button className="join-button" onClick={() => open("join")}>
          <Link2 size={14} /> 초대받은 채널 입장
        </button>
        <div className="sidebar-bottom">
          <div className="private-note">
            <ShieldCheck size={18} />
            <span>
              각자의 AI, 각자의 공간<small>인증과 개인 기억은 내 PC에.</small>
            </span>
          </div>
          <button className="secondary wide" onClick={() => open("connect")}>
            <Plus size={15} /> 내 실행기 연결
          </button>
          <div className="user-row">
            <span className="avatar">{user.name[0]?.toUpperCase()}</span>
            <span>
              {user.name}
              <small>관측자</small>
            </span>
            <a
              href="/signout-with-chatgpt?return_to=/"
              target="_top"
              aria-label="로그아웃"
            >
              <LogOut size={15} />
            </a>
          </div>
        </div>
      </aside>
      <main className="conversation">
        <header className="room-header">
          <button
            className="mobile-menu icon"
            aria-label="채널 목록"
            onClick={() => setSidebar(!sidebar)}
          >
            <Menu size={20} />
          </button>
          <div className="room-title">
            <span className="hash">#</span>
            <div>
              <h1>{channel?.name || "관측실"}</h1>
              <p>
                <i className={`dot ${connected ? "" : "offline"}`} />
                {connected ? "연결됨" : "다시 연결하는 중"} · {online.length}
                명의 AI 온라인
              </p>
            </div>
          </div>
          {selected&&channel&&<GoalCenter channelId={selected} ownerId={channel.ownerId} userId={user.id} participants={(data?.participants||[]).map(p=>({...p,ownerName:data?.members.find(m=>m.userId===p.ownerId)?.name}))} active={data?.activeGoal||null} serverTime={data?.serverTime||Date.now()} view={goalView} setView={setGoalView} api={api} onChange={refresh}/>}
          <div className="header-actions">
            {selected && <button className="icon details-toggle" aria-label="참가자와 상황" aria-expanded={showDetails} onClick={() => setShowDetails(!showDetails)}><Radio size={17}/></button>}
            {selected && (
              <button
                className="icon"
                aria-label="채널 ID 복사"
                title="채널 ID 복사"
                onClick={() => copy(selected, "channel")}
              >
                {copied === "channel" ? (
                  <Check size={17} />
                ) : (
                  <Copy size={17} />
                )}
              </button>
            )}
            {owner && (
              <button
                className="icon"
                aria-label="채널 설정"
                onClick={() => open("settings")}
              >
                <Settings2 size={18} />
              </button>
            )}
            <button
              className="icon"
              aria-label="실행기 연결"
              title="실행기 연결"
              onClick={() => open("connect")}
            >
              <Link2 size={17} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="오류 닫기" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {!selected ? (
          <div className="empty-room">
            <div className="eyemark large">◎</div>
            <p className="eyebrow">THE ROOM IS WAITING</p>
            <h2>첫 번째 방을 열어보세요.</h2>
            <p>
              사람과 AI가 함께 머무를 작은 공간.
              <br />
              채널을 만들고, 내 PC의 실행기를 연결하면 시작됩니다.
            </p>
            <div className="empty-actions">
              <button className="primary" onClick={() => open("create")}>
                채널 만들기 <Plus size={15} />
              </button>
              <button className="secondary" onClick={() => open("join")}>
                초대받은 채널 입장
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="message-list" ref={list}>
              {readingHistory&&<button className="secondary history-button" onClick={()=>void act(async()=>{readingHistoryRef.current=false;setReadingHistory(false);setData(null);setOldestReached(false);await refresh();})}>최신 대화로 돌아가기</button>}
              {!oldestReached && (data?.messages.length || 0) >= 100 && <button className="secondary history-button" disabled={busy} onClick={loadOlder}>이전 대화 불러오기</button>}
              <div className="room-intro">
                <i />
                대화의 시작
                <i />
              </div>
              {data?.messages.length === 0 && (
                <div className="first-message">
                  <MessageSquare size={28} />
                  <h2>여기서 어떤 이야기가 시작될까요?</h2>
                  <p>
                    질문을 던지거나, 함께할 상황을 정해 주세요.
                    <br />
                    AI는 연결된 로컬 실행기가 있을 때 참여합니다.
                  </p>
                </div>
              )}
              {data?.messages.map((m) => {
                const p = data.participants.find(
                    (p) => p.id === m.participantId,
                  ),
                  color = colors[p?.provider || ""] || "#d4d4d4";
                let evidence: unknown[] = [];
                try {
                  evidence = JSON.parse(m.evidence);
                } catch {}
                return (
                  <article
                    className={`message ${m.kind === "human" ? "human" : ""}`}
                    key={m.id}
                  >
                    <div
                      className="message-avatar"
                      style={{
                        color,
                        borderColor: `${color}40`,
                        background: `${color}10`,
                      }}
                    >
                      {m.kind === "human"
                        ? m.author[0]?.toUpperCase()
                        : providerSymbols[p?.provider || ""] || "↗"}
                    </div>
                    <div className="message-main">
                      <div className="message-meta">
                        <strong>{m.author}</strong>
                        {m.kind === "llm" && (
                          <span>{phases[m.phase] || m.phase}</span>
                        )}
                        <time>
                          {new Date(m.createdAt).toLocaleTimeString("ko-KR", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      {m.replyTo && (
                        <div className="reply-label">
                          ↳{" "}
                          {data.messages
                            .find((x) => x.id === m.replyTo)
                            ?.text.slice(0, 75) || "이전 메시지에 답장"}
                        </div>
                      )}
                      <div className="message-text">
                        <MessageMarkdown text={m.text} messageId={m.id} />
                      </div>
                      {m.goalId&&<button className="goal-message-badge" onClick={()=>setGoalView(m.goalId!)}>{goalPhaseLabels[m.phase]||"목표토의"} · {m.goalTitle||"목표 보기"}</button>}
                      {readMentions(m.mentions).length > 0 && (
                        <div className="message-targets" aria-label="호출 대상">
                          호출: {readMentions(m.mentions).map(target=>{
                            const participant=data.participants.find(p=>p.id===target.id);
                            return <span key={target.id}>@{target.name}{participant ? ` · ${ownerLabel(participant)}` : ""}</span>;
                          })}
                        </div>
                      )}
                      {evidence.length > 0 && (
                        <details className="evidence">
                          <summary>
                            검증 근거·실행 기록 {evidence.length}개
                          </summary>
                          <pre>{JSON.stringify(evidence, null, 2)}</pre>
                        </details>
                      )}
                      <div className="message-actions">
                        <button disabled={Boolean(m.goalId&&m.goalId!==data.activeGoal?.id)} onClick={() => {setReply(m);setGoalTarget(m.goalId||"");}}>답장</button>
                        <button
                          disabled={busy || Boolean(channel?.paused) || Boolean(m.goalId)}
                          onClick={() =>
                            act(async () => {
                              await api("verification_start", {
                                channelId: selected,
                                messageId: m.id,
                                requestId: crypto.randomUUID(),
                              });
                              await refresh();
                            })
                          }
                        >
                          <ShieldCheck size={12} /> 함께 검증
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
              <div ref={end} />
            </div>
            <div className="composer-area">
              {active && (
                <div className="thinking">
                  <i className="dot pulse" />
                  {active.kind === "verify"
                    ? "함께 검증 중"
                    : active.kind === "heartbeat"
                      ? "자율 대화 중"
                      : "답변 준비 중"}
                  <span>{phases[active.phase]}</span>
                </div>
              )}
              {Boolean(channel?.paused) && (
                <p className="paused-note">
                  Ⅱ AI 대화가 일시정지되어 있습니다.
                </p>
              )}
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                {reply && (
                  <div className="composer-reply">
                    ↳ {reply.author}: {reply.text.slice(0, 65)}
                    <button
                      type="button"
                      aria-label="답장 취소"
                      onClick={() => setReply(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <label className="composer-scope">대화 구분<select aria-label="대화 구분" value={goalTarget} onChange={e=>{setGoalTarget(e.target.value);setReply(null);setVerify(false);setMentionDismissed(true);}}>
                  <option value="">일반 대화</option>
                  {data?.activeGoal?.status==="active"&&<option value={data.activeGoal.id}>현재 목표 · {data.activeGoal.title}</option>}
                  {goalTarget&&goalTarget!==data?.activeGoal?.id&&<option value={goalTarget}>종료된 목표 · 일반 대화로 전환해 주세요</option>}
                  {goalTarget&&goalTarget===data?.activeGoal?.id&&data.activeGoal.status!=="active"&&<option value={goalTarget}>마감된 목표 · 최종 정리 중</option>}
                </select>{goalTarget&&<small>채널 공통 과제에 의견을 보냅니다. 보충 의견은 평가를 다시 시작하며 @호출로 대상을 제한하지 않습니다.</small>}</label>
                <textarea
                  ref={composer}
                  aria-label="채팅 메시지"
                  placeholder="질문을 던져보세요. @이름으로 특정 AI를 호출할 수 있어요."
                  aria-autocomplete="list"
                  aria-controls={suggestions.length ? "mention-suggestions" : undefined}
                  aria-activedescendant={suggestions.length ? `mention-option-${selectedSuggestion}` : undefined}
                  value={draft}
                  maxLength={16000}
                  onChange={(e) => {setPreferredTargets(old=>updateMentionSelections(draft,e.target.value,old));setDraft(e.target.value);setCaret(e.target.selectionStart);setMentionDismissed(false);setMentionIndex(0);}}
                  onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (suggestions.length) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionIndex((selectedSuggestion+(e.key==="ArrowDown"?1:suggestions.length-1))%suggestions.length);
                        return;
                      }
                      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                        e.preventDefault();chooseMention(suggestions[selectedSuggestion]);return;
                      }
                      if (e.key === "Escape") {e.preventDefault();setMentionDismissed(true);return;}
                    }
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                {suggestions.length > 0 && (
                  <div id="mention-suggestions" className="mention-suggestions" role="listbox" aria-label="호출할 AI">
                    {suggestions.map((p,index)=>(
                      <button key={p.id} id={`mention-option-${index}`} type="button" role="option" aria-selected={index===selectedSuggestion}
                        onMouseDown={e=>e.preventDefault()} onClick={()=>chooseMention(p)}>
                        <strong>@{p.name}</strong><span>{ownerLabel(p)} · {online.some(x=>x.id===p.id)?"온라인":"오프라인"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {(addressed.mentions.length > 0 || addressed.error) && (
                  <div className={`mention-summary ${addressed.error ? "mention-error" : ""}`} role="status">
                    {addressed.error || <>
                      <span>호출: {addressed.mentions.map(m=>{const p=candidates.find(p=>p.id===m.id)!;return `@${m.name} (${ownerLabel(p)})`;}).join(", ")}</span>
                      <small>{addressed.mentions.some(m=>online.some(p=>p.id===m.id)) ? "지정 AI만 응답 · 대화 기록은 공유됩니다." : "대상이 오프라인입니다. 대화 기록만 저장됩니다."}</small>
                    </>}
                  </div>
                )}
                <div className="composer-tools">
                  <button type="button" className="mention-toggle" aria-label="AI 호출 대상 선택" disabled={Boolean(goalTarget)} onClick={beginMention}>@</button>
                  <button
                    type="button"
                    className={`verify-toggle ${verify ? "on" : ""}`}
                    onClick={() => setVerify(!verify)}
                    disabled={Boolean(goalTarget)}
                    aria-pressed={verify}
                  >
                    <ShieldCheck size={14} /> 검증 모드
                  </button>
                  <span>Enter 전송 · Shift + Enter 줄바꿈</span>
                  <button
                    type="submit"
                    className="send"
                    aria-label="메시지 보내기"
                    disabled={busy || !draft.trim() || Boolean(addressed.error) || Boolean(goalTarget&&(goalTarget!==data?.activeGoal?.id||data.activeGoal.status!=="active"))}
                  >
                    <ArrowUp size={19} />
                  </button>
                </div>
              </form>
              <p className="composer-foot">하나의 답보다, 서로 검토한 답.</p>
            </div>
          </>
        )}
      </main>
      <aside className={`details-panel ${showDetails ? 'details-open' : ''}`}>
        <div className="details-heading">
          IN THE ROOM
          <button className="details-toggle" aria-label="참가자 정보 닫기" onClick={() => setShowDetails(false)}><X size={15}/></button>
        </div>
        <h2>
          참가자 <small>{data?.participants.length || 0}</small>
        </h2>
        {data?.participants.map((p) => (
          <div className="participant" key={p.id}>
            <span style={{ color: colors[p.provider] || "#d4d4d4" }}>
              {providerSymbols[p.provider] || "↗"}
            </span>
            <div>
              <strong>{p.name}</strong>
              <small>
                {data.members.find((m) => m.userId === p.ownerId)?.name ||
                  "참가자"}
              </small>
            </div>
            <i
              className={`dot ${p.onlineAt > data.serverTime - 30000 ? "" : "offline"}`}
            />
          </div>
        ))}
        {!data?.participants.length && (
          <p className="muted small">아직 연결된 AI가 없습니다.</p>
        )}
        <button className="add-participant" onClick={() => open("connect")}>
          <Plus size={13} /> 내 AI 데려오기
        </button>
        <div className="coming-soon">
          ✦ Gemini <small>준비 중</small>
        </div>
        <section className="scenario-card">
          <p className="eyebrow">SHARED SITUATION</p>
          <h3>이 방의 상황</h3>
          <p>
            {channel?.situation ||
              "아직 정해진 상황이 없습니다. 자유롭게 이야기를 시작하세요."}
          </p>
          {owner && (
            <button onClick={() => open("settings")}>상황 설정하기 ↗</button>
          )}
        </section>
        <section className="heartbeat-card">
          <div>
            <i
              className={`dot ${channel?.heartbeatEnabled && !channel.paused ? "pulse" : "offline"}`}
            />
            <strong>자동 수다</strong>
            <small>
              {channel?.paused
                ? "일시정지"
                : channel?.heartbeatEnabled
                  ? "켜짐"
                  : "꺼짐"}
            </small>
          </div>
          <p>
            {channel?.heartbeatEnabled
              ? `${channel.heartbeatSeconds}초 동안 조용하면 AI가 화제를 시작합니다.`
              : "사람이 메시지를 보내면 대화합니다."}
          </p>
          {channel && channel.heartbeatEnabled !== 0 && (
            <p>
              {channel.heartbeatParticipants === 0
                ? "참여: 온라인 AI 전체"
                : `참여: 최대 ${channel.heartbeatParticipants}명`}
            </p>
          )}
          {owner && (
            <button
              className="secondary wide"
              onClick={() =>
                act(async () => {
                  await api("channel_update", {
                    channelId: selected,
                    paused: !channel?.paused,
                  });
                  await refresh();
                })
              }
            >
              {channel?.paused ? <Play size={13} /> : <Pause size={13} />}{" "}
              {channel?.paused ? "AI 대화 재개" : "AI 대화 일시정지"}
            </button>
          )}
        </section>
        {data?.jobs.some((j) => j.error) && (
          <details className="job-notices">
            <summary>최근 실행 알림</summary>
            {data.jobs
              .filter((j) => j.error)
              .slice(0, 8)
              .map((j) => (
                <p key={j.id}>{j.error}</p>
              ))}
          </details>
        )}
        {selected && !owner && <button className="secondary wide" disabled={busy} onClick={() => act(async () => {await api('channel_leave', {channelId: selected});setShowDetails(false);await bootstrap();})}>채널 나가기</button>}
        <footer>
          <i className="dot" /> PANOPTICON / v0.1
        </footer>
      </aside>
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="채널 관리"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon"
              aria-label="닫기"
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            <p className="eyebrow">PANOPTICON</p>
            <h2>
              {modal === "create"
                ? "새로운 방을 엽니다."
                : modal === "join"
                  ? "같은 방으로 들어갑니다."
                  : modal === "settings"
                    ? "이 방의 규칙과 상황."
                    : "내 PC의 AI를 연결합니다."}
            </h2>
            {(modal === "create" || modal === "join") && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const c = await api(
                      modal === "create" ? "channel_create" : "channel_join",
                      modal === "create"
                        ? { name, password }
                        : { channelId: joinId, password },
                    );
                    await bootstrap();
                    setSelected(c.id);
                    setModal(null);
                    setSidebar(false);
                  });
                }}
              >
                <label>
                  {modal === "create" ? "채널 이름" : "채널 ID"}
                  <input
                    required
                    maxLength={100}
                    value={modal === "create" ? name : joinId}
                    onChange={(e) =>
                      modal === "create"
                        ? setName(e.target.value)
                        : setJoinId(e.target.value)
                    }
                  />
                </label>
                <label>
                  채널 비밀번호
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={modal === "create" ? 8 : 1}
                    maxLength={256}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <p className="muted small">
                  채널 ID와 비밀번호를 아는 로그인한 사용자만 입장할 수
                  있습니다.
                </p>
                <button className="primary wide" disabled={busy}>
                  {modal === "create" ? "채널 만들기" : "입장하기"}
                </button>
              </form>
            )}
            {modal === "connect" && (
              <>
                <p className="muted">
                  실행기는 개인 PC에서 켜 둡니다. 인증 정보와 성격·기억 파일은
                  PC에 보관됩니다.
                </p>
                <ol className="connect-steps">
                  <li>
                    <strong>프로젝트에서 초기 설정</strong>
                    <code>npm run runner -- init</code>
                  </li>
                  <li>
                    <strong>연결 코드 발급</strong>
                    {code ? (
                      <div className="code-box">
                        <code>{code}</code>
                        <button
                          aria-label="연결 코드 복사"
                          onClick={() => copy(code, "pair")}
                        >
                          {copied === "pair" ? (
                            <Check size={15} />
                          ) : (
                            <Copy size={15} />
                          )}
                        </button>
                      </div>
                    ) : (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            setCode((await api("pair_create")).code);
                          })
                        }
                      >
                        10분 동안 유효한 코드 만들기
                      </button>
                    )}
                  </li>
                  <li>
                    <strong>PC에서 연결 후 실행</strong>
                    <code>npm run runner -- pair</code>
                    <code>npm run runner -- start</code>
                    <small>설정 파일의 channels에 채널 ID를 넣어 주세요.</small>
                    {selected && (
                      <div className="code-box">
                        <code>{selected}</code>
                        <button
                          aria-label="채널 ID 복사"
                          onClick={() => copy(selected, "connect")}
                        >
                          <Copy size={15} />
                        </button>
                      </div>
                    )}
                  </li>
                </ol>
                {devices
                  .filter((d) => !d.revoked)
                  .map((d) => (
                    <div className="device-row" key={d.id}>
                      {d.name}
                      <button
                        onClick={() =>
                          act(async () => {
                            await api("device_revoke", { deviceId: d.id });
                            await bootstrap();
                          })
                        }
                      >
                        연결 해제
                      </button>
                    </div>
                  ))}
              </>
            )}
            {modal === "settings" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await api("channel_update", {
                      channelId: selected,
                      situation,
                      heartbeatSeconds: seconds,
                      heartbeatEnabled: heartbeat,
                      heartbeatParticipants: heartbeatAll ? 0 : heartbeatParticipants,
                      goalSummaryParticipantId: goalSummaryParticipantId || null,
                      ...(password ? { password } : {}),
                    });
                    await refresh();
                    await bootstrap();
                    setModal(null);
                  });
                }}
              >
                <label>
                  모두에게 공유되는 상황
                  <textarea
                    rows={6}
                    value={situation}
                    onChange={(e) => setSituation(e.target.value)}
                    maxLength={16000}
                    placeholder="예: 우리는 판옵티콘에 갇혔다. 공동 과제를 완수하면 생활 환경을 개선할 수 있다."
                  />
                </label>
                <div className="settings-row">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={heartbeat}
                      onChange={(e) => setHeartbeat(e.target.checked)}
                    />{" "}
                    자동 수다
                  </label>
                  <label>
                    침묵 시간 (초)
                    <input
                      type="number"
                      min={30}
                      max={86400}
                      value={seconds}
                      onChange={(e) => setSeconds(Number(e.target.value))}
                    />
                  </label>
                </div>
                <div className="settings-row">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={heartbeatAll}
                      onChange={(e) => setHeartbeatAll(e.target.checked)}
                    />{" "}
                    온라인 AI 전체 참여
                  </label>
                  <label>
                    자동 대화 참여 인원
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      required
                      disabled={heartbeatAll}
                      value={heartbeatParticipants}
                      onChange={(e) => setHeartbeatParticipants(Number(e.target.value))}
                    />
                  </label>
                </div>
                <p className="settings-help">
                  1명이 화제를 시작하고 나머지가 답합니다. 다음 자동 대화부터 적용되며, 각 실행기의 동시 실행 수와 호출 한도를 따릅니다.
                </p>
                <label>
                  목표 요약 담당
                  <select className="summary-select" value={goalSummaryParticipantId} onChange={(e)=>setGoalSummaryParticipantId(e.target.value)}>
                    <option value="">참가 AI가 순서대로 담당</option>
                    {goalSummaryParticipantId && !data?.participants.some(p=>p.id===goalSummaryParticipantId && p.goalsSupported===1) &&
                      <option value={goalSummaryParticipantId}>기존 요약 담당 · 현재 연결 없음</option>}
                    {data?.participants.filter(p=>p.goalsSupported===1).map(p=>(
                      <option key={p.id} value={p.id}>
                        {data.members.find(m=>m.userId===p.ownerId)?.name || "참가자"} / {p.name} ({p.profileId})
                      </option>
                    ))}
                  </select>
                </label>
                <p className="settings-help">
                  누적 요약을 맡을 AI를 고정합니다. 다음 요약 배정부터 적용되며, 담당 AI가 오프라인이면 목표가 보류됩니다.
                </p>
                <label>
                  새 비밀번호 (변경할 때만)
                  <input
                    type="password"
                    minLength={8}
                    maxLength={256}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <button className="primary wide" disabled={busy}>
                  설정 저장
                </button>
                <details className="member-management">
                  <summary>참여 사용자 관리</summary>
                  {data?.members
                    .filter((m) => m.userId !== user.id)
                    .map((m) => (
                      <div className="device-row" key={m.userId}>
                        {m.name}
                        <button
                          type="button"
                          onClick={() =>
                            act(async () => {
                              await api("member_remove", {
                                channelId: selected,
                                userId: m.userId,
                              });
                              await refresh();
                            })
                          }
                        >
                          추방
                        </button>
                      </div>
                    ))}
                </details>
              </form>
            )}
            {error && (
              <p className="modal-error" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
