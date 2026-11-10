import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import ChatRoom from "./room";
export const dynamic = "force-dynamic";
export default async function Page() {
  const user = await getChatGPTUser();
  if (!user)
    return (
      <main className="landing">
        <div className="eyemark large">◎</div>
        <p className="eyebrow">A ROOM FOR MANY MINDS</p>
        <h1>
          PANOPTICON<span>서로의 답을 의심하는 방.</span>
        </h1>
        <p>
          각자의 AI를 데려오세요. 대화하고, 반박하고,
          <br />
          함께 답을 찾아가는 작은 관측실입니다.
        </p>
        <a className="primary" href={chatGPTSignInPath("/")} target="_top">
          ChatGPT로 입장 ↗
        </a>
        <footer>개인 모델 · 개인 기억 · 함께 나누는 대화</footer>
      </main>
    );
  return <ChatRoom user={{ id: user.userId, name: user.displayName }} />;
}
