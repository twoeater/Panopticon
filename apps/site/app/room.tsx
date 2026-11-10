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
type Snapshot = {
  channel: Channel;
  messages: Message[];
  participants: Participant[];
  members: { userId: string; name: string }[];
  rounds: Round[];
  jobs: Job[];
  serverTime: number;
};
const phases: Record<string, string> = {
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
function Text({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s<>]+)/g).map((s, i) =>
        /^https?:\/\//.test(s) ? (
          <a key={i} href={s} target="_blank" rel="noreferrer">
            {s}
          </a>
        ) : (
          <span key={i}>{s}</span>
        ),
      )}
    </>
  );
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
    [copied, setCopied] = useState("");
  const list = useRef<HTMLDivElement>(null),
    end = useRef<HTMLDivElement>(null),
    selectedRef = useRef(selected),
    pending = useRef<{ id: string; text: string; channel: string } | null>(
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
    setData(old => old && old.channel.id === r.channel.id ? {...r, messages: [...new Map([...old.messages, ...r.messages].map(m => [m.id, m])).values()].sort((a,b) => a.seq-b.seq)} : r);
    setConnected(true);
    if (bottom)
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
    const current = selected, height = list.current?.scrollHeight || 0;
    const r: Snapshot = await api('snapshot', {channelId: current, before: data.messages[0].seq});
    if (selectedRef.current !== current) return;
    setOldestReached(r.messages.length < 100);
    setData(old => old ? {...old, messages: [...new Map([...r.messages, ...old.messages].map(m => [m.id,m])).values()].sort((a,b)=>a.seq-b.seq)} : old);
    requestAnimationFrame(() => { if(list.current) list.current.scrollTop += list.current.scrollHeight-height; });
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
    }
  };
  const send = () =>
    act(async () => {
      if (!draft.trim() || !selected) return;
      const text = draft.trim();
      const nonce =
        pending.current?.text === text && pending.current.channel === selected
          ? pending.current.id
          : crypto.randomUUID();
      pending.current = { id: nonce, text, channel: selected };
      await api("message_post", {
        channelId: selected,
        text,
        clientMessageId: nonce,
        replyTo: reply?.id,
        verify,
      });
      pending.current = null;
      setDraft("");
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
                        <Text text={m.text} />
                      </div>
                      {evidence.length > 0 && (
                        <details className="evidence">
                          <summary>
                            검증 근거·실행 기록 {evidence.length}개
                          </summary>
                          <pre>{JSON.stringify(evidence, null, 2)}</pre>
                        </details>
                      )}
                      <div className="message-actions">
                        <button onClick={() => setReply(m)}>답장</button>
                        <button
                          disabled={busy || Boolean(channel?.paused)}
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
                <textarea
                  aria-label="채팅 메시지"
                  placeholder="질문을 던져보세요. 서로 다른 관점이 모입니다."
                  value={draft}
                  maxLength={16000}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
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
                <div className="composer-tools">
                  <button
                    type="button"
                    className={`verify-toggle ${verify ? "on" : ""}`}
                    onClick={() => setVerify(!verify)}
                    aria-pressed={verify}
                  >
                    <ShieldCheck size={14} /> 검증 모드
                  </button>
                  <span>Enter 전송 · Shift + Enter 줄바꿈</span>
                  <button
                    type="submit"
                    className="send"
                    aria-label="메시지 보내기"
                    disabled={busy || !draft.trim()}
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
