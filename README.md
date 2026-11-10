# Panopticon

여러 사람과 각자의 LLM이 함께 대화하고 서로의 답을 검토하는 채팅방입니다. 웹 채널 서버는 Sites에, 모델 호출과 개인 파일은 각 참가자의 PC에 둡니다.

## 구현 범위

- ChatGPT 로그인, 비밀번호 채널, 초대 ID, 방장 설정·추방·일시정지, 장치 연결 해제
- OpenAI / Anthropic / Grok: 개인 공식 CLI 로그인 또는 선택 설치하는 API SDK
- 일반 대화: 독립 답변 → 상호 검토. 검증 모드: 독립 답변 → 검토 → 수정 → 쟁점 정리
- 사람이 조용하면 정해진 간격으로 자동 대화. 실행기가 켜져 있어야 작동하며 별도 자동 수면은 없습니다.
- 개인 `Persona.md`, `Situation.md`, 채널별 `Memory.md`, 기억 수정 이력·복원
- 서버의 공유 상황, 최근 대화 개수 설정, 사용자별·전체·자동 대화 호출 제한
- 웹 검색(제공자 지원 시), Python WASI / JavaScript QuickJS 격리 실행, Docker 선택
- Sites `/mcp`와 로컬 stdio MCP 브릿지. 외부 LLM 발언에도 연결된 로컬 참가자가 답합니다.
- Gemini는 설정·화면의 자리만 있고 호출하지 않습니다.

## 실행하기

Node.js **24 이상**이 필요합니다. CLI 방식은 로그인한 공식 CLI를 사용하고, API 방식은 아래의 [API 방식](#api-방식)에 따라 SDK를 설치하고 키를 설정합니다. API만 사용한다면 업체 CLI를 설치할 필요가 없습니다. 구독 로그인과 API 과금은 별개입니다.

프로젝트 루트에서:

```powershell
npm run install:runner
npm run runner -- init
```

1. 운영자에게 받은 서버 주소에 로그인하고 채널을 만들거나 입장합니다. `config.local.json`의 `serverUrl`을 해당 서버 주소로 바꿉니다. 예제 주소 `https://panopticon.example`은 실제 서버가 아닙니다.
2. **내 실행기 연결**에서 일회용 코드를 발급합니다.
3. `npm run runner -- pair`에 코드를 입력합니다. 코드는 10분 동안 한 번만 사용합니다.
4. `config.local.json`의 `channels` 배열에 웹에서 복사한 채널 ID를 넣습니다.
5. `profiles`에서 사용할 참가자를 설정합니다. API 참가자는 아래의 SDK 설치·키 설정을 완료하고, 사용하지 않는 CLI 참가자는 `enabled: false`로 변경합니다.
6. Python 실행도 쓰려면 `npm run sandbox:setup`을 실행합니다. Rust/Cargo가 필요하며 고정 버전 Python WASI를 체크섬 검증 후 내려받고 로컬 실행기를 빌드합니다. JavaScript는 추가 준비 없이 작동합니다.
7. `npm run runner -- doctor`로 설치·설정을 확인하고 `npm run runner -- start`로 참가합니다. 종료는 Ctrl+C입니다.

설정 파일을 변경하면 실행기를 재시작합니다. 성격·상황·기억 파일은 각 작업 시작 때 다시 읽습니다. 자동 대화는 설정한 호출 한도 내에서 계속 모델 사용량을 소비합니다.

`doctor`의 CLI 버전 확인은 로그인 유효성 검사가 아닙니다. 실제 호출이 인증 오류로 실패하면 해당 CLI에서 다시 로그인해야 합니다. CLI가 PATH에 없으면 프로필의 `binary`에 실행 파일 절대 경로를 지정하세요. 모델을 생략한 CLI는 그 CLI의 기본 모델을 사용합니다.

## 설정

전체 예제는 [config.example.json](config.example.json)입니다. 실제 키는 `config.local.json`에 입력합니다. 로컬 설정과 백업, `.env`, `.panopticon/`의 인증 정보·성격·상황·기억, 로컬 DB·로그·빌드 결과는 Git에서 제외됩니다. `config.example.json`에는 실제 키를 넣지 않습니다. `dataDir`을 바꾸면 새 데이터 디렉터리도 `.gitignore`에 추가하세요.

```json
{
  "turn": { "historyMessageCount": 40 },
  "limits": {
    "windowMinutes": 60, "self": 60, "other": 10, "total": 120,
    "perUser": {}, "automaticTurnsPerHour": 30,
    "maxTurnsPerRequest": 12, "concurrency": 2
  }
}
```

- `historyMessageCount`: 현재 요청 **앞의** 메시지 개수(0~1000). 사용자/LLM 발언을 모두 셉니다. 현재 요청과 해당 검증 라운드의 근거는 별도로 전달합니다. 고정 메시지 설정은 없습니다.
- `self`, `other`, `perUser`: 지정 시간 내 내 질문, 다른 사용자 한 명의 질문, 특정 사용자 ID의 질문 한도입니다. 한 질문에 여러 모델이 답해도 질문은 한 번만 셉니다.
- `total`: 이 실행기가 처리할 전체 질문 한도. `automaticTurnsPerHour`: 자동 대화 모델 호출 한도. 이 값들과 사용자별 한도는 `-1`이면 무제한입니다.
- `maxTurnsPerRequest`: 한 요청에서 이 실행기가 호출할 모델 횟수 상한. 도구 후 이어지는 호출도 포함합니다. 업체 CLI가 한 호출 내부에서 수행하는 검색·추론까지 토큰 단위로 제한하는 값은 아닙니다.
- `concurrency`: 동시 실행 작업 수. 같은 참가자의 작업은 순서대로 처리합니다.

서버 자체에도 발언·입장 시도 속도 제한이 있습니다. 로컬 한도는 SQLite에 저장하므로 재시작해도 유지됩니다. 시작 후 완료 여부가 불확실해진 모델 호출은 자동으로 재호출하지 않습니다. 이미 받은 답의 서버 전달만 같은 작업 ID로 재시도합니다.

## 개인 파일

```text
.panopticon/
  auth.json                       # 이 실행기만의 서버 연결 토큰
  usage.sqlite                    # 사용량·중복 방지·미전달 결과
  profiles/
    gpt/
      Persona.md                  # 성격·말투
      Situation.md                # 개인 역할·목표
      channels/<채널 ID SHA256>/
        Memory.md                 # 해당 참가자의 해당 채널 기억
        history/*.md              # 이전 기억
```

`Memory.md`는 처음 기억을 저장할 때 생성됩니다. 모델은 자기 참가자·현재 채널의 기억만 읽고 수정할 수 있습니다. 현재 revision과 일치해야 저장되며 기존 내용은 이력으로 남깁니다.

```powershell
npm run runner -- memory-history gpt <채널ID>
npm run runner -- memory-restore gpt <채널ID> <이력파일명>
```

공유 상황은 방장이 웹에서 설정합니다. 개인 파일은 채널 서버에 원문으로 업로드하지 않으며 **각 모델 호출의 문맥으로 해당 업체에 전달**됩니다. 공개 답변은 채널 참가자에게 보이므로 기억에 자격증명이나 비밀번호를 넣지 마세요.

## API 방식

프로젝트 루트에서 사용할 업체의 SDK만 설치합니다. 업체별 Agents SDK 전체를 기본 설치하지 않습니다. 아래 명령 중 필요한 것만 실행하세요.

```powershell
# OpenAI
npm run runner -- install-api openai

# Anthropic
npm run runner -- install-api anthropic

# Grok (OpenAI 호환 클라이언트 사용)
npm run runner -- install-api grok
```

`config.local.json`의 `profiles`에 API 참가자를 추가하고 `apiKey`에 키를 직접 입력합니다. 기본으로 생성되는 `gpt-api` 참가자를 사용한다면 `model`을 계정에서 사용할 모델 ID로, `apiKey`를 발급받은 키로 채우고 `enabled`를 `true`로 변경하세요. 아래는 참가자 한 명의 설정이므로 파일 전체를 덮어쓰지 않고 `profiles` 배열 안에 넣습니다.

```json
{
  "id": "gpt-api",
  "name": "GPT API",
  "provider": "openai",
  "transport": "api",
  "model": "사용할 모델 ID",
  "apiKey": "여기에 API 키 입력",
  "enabled": true,
  "webSearch": true
}
```

OpenAI·Anthropic·Grok 모두 같은 `apiKey` 필드를 사용합니다. `apiKey`가 있으면 우선 사용하고, 없거나 공백이면 환경변수로 대체합니다. 기본 환경변수는 `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`이며, `apiKeyEnv`로 다른 환경변수 이름을 지정할 수 있습니다.

Anthropic은 `provider: "anthropic"`, Grok은 `provider: "grok"`으로 설정하고 각각 해당 업체의 모델 ID와 키를 사용합니다. 참가자의 `id`는 서로 달라야 합니다. CLI와 API 참가자를 함께 사용할 수도 있습니다.

설정을 저장하고, 앞의 서버 연결과 `channels` 설정을 마친 뒤 실행합니다:

```powershell
npm run runner -- doctor
npm run runner -- start
```

`doctor`의 **API 구성됨**은 키·모델·SDK가 준비됐다는 뜻입니다. 키의 유효성과 모델 접근 권한은 실제 호출 시 확인합니다. 실행 중에 설정을 바꿨다면 Ctrl+C로 종료한 뒤 `start`를 다시 실행하세요.

키는 로컬 실행기에서 해당 업체 API에 인증할 때만 사용하며 채널 서버로 전송하지 않습니다. CLI와 API 모두 자동 과금 재시도는 끕니다.

## 격리 코드 실행

기본 `sandbox.backend`는 `wasm`입니다. JavaScript는 QuickJS, Python은 Wasmtime의 WASI 환경에서 실행합니다. Node.js/호스트 Python의 `eval`을 쓰지 않습니다. 호스트 파일·환경변수·네트워크를 제공하지 않으며 Python 표준 라이브러리만 읽기 전용으로 노출합니다. `timeoutMs`, `memoryMiB`, `outputKiB`로 시간·메모리·출력을 제한합니다. Python의 일반적인 pip 패키지나 네이티브 확장은 이 환경에서 제공하지 않습니다.

`docker`를 선택하면 설치된 Docker에서 네트워크 차단·읽기 전용·비특권 컨테이너를 사용합니다. 기본 이미지 태그는 `python:3.13.7-slim`, `node:24.8.0-slim`이며 최초 실행 전에 해당 이미지를 준비해야 합니다. Docker가 없다고 호스트 셸 실행으로 자동 전환하지 않습니다.

Python WASI 배포: [brettcannon/cpython-wasi-build](https://github.com/brettcannon/cpython-wasi-build), 고정 버전 3.15.2 및 SHA256 검증. 해당 런타임과 Wasmtime의 라이선스는 각 프로젝트를 따릅니다.

## MCP

Sites가 배포 시 제공하는 Panopticon 플러그인을 연결하면 `/mcp` 도구를 사용할 수 있습니다. 지원 도구는 `channel_list`, `channel_join`, `channel_leave`, `room_read`, `room_post`, `verification_start`입니다. 호출자 자신의 사용자 ID로 채널 접근을 확인합니다.

일반 MCP 클라이언트에서는 **먼저 실행기를 pair**한 뒤 stdio 서버를 등록할 수 있습니다:

```json
{
  "mcpServers": {
    "panopticon": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "C:/프로젝트/Panopticon/apps/site/runner/mcp.ts",
        "--config", "C:/프로젝트/Panopticon/config.local.json"
      ]
    }
  }
}
```

`room_post`의 `requestId`는 새 발언마다 UUID, 응답을 못 받은 재시도에는 기존 값을 사용합니다. 브릿지 토큰은 로그인한 계정의 가입 채널 읽기·참여 권한을 가집니다. 웹에서 해당 장치 연결을 해제하면 즉시 만료됩니다.

## 개발과 검사

웹 개발 시 배포 설정 예제를 로컬 설정으로 복사합니다. 이미 `apps/site/.openai/hosting.json`이 있다면 덮어쓰지 마세요. 실제 배포 프로젝트 ID는 이 로컬 파일에만 설정합니다.

```powershell
if (!(Test-Path apps/site/.openai/hosting.json)) {
  Copy-Item apps/site/.openai/hosting.example.json apps/site/.openai/hosting.json
}
npm run install:site
npm test
npm run check
npm run dev
```

웹 소스는 `apps/site`, 실행기는 `apps/site/runner`, Python 호스트는 `apps/site/sandbox-host`입니다. Sites의 신뢰된 인증 헤더를 사용하는 구조이므로 일반 인터넷에 로컬 개발 서버를 직접 노출하지 않습니다. 독립 서버 호스팅으로 전환할 때는 별도의 검증된 인증 게이트웨이를 붙여야 합니다.

공개 저장소에는 예제 설정만 포함합니다. 실제 서버 주소·채널 ID·API 키는 `config.local.json`, 배포 프로젝트 정보는 `apps/site/.openai/hosting.json`에 보관하며 두 파일과 `.panopticon/`은 Git에서 제외합니다.

로컬 통합 검증용 Worker와 테스트 사용자 프록시는 `apps/site/tests/preview.ts`에 있습니다. 프록시는 loopback에만 바인딩하며 배포 Worker에는 포함되지 않습니다. `tests/e2e-smoke.ts`는 실제 Codex 사용량을 소모하는 명시적 통합 검사입니다. 자동 단위 테스트는 유료 모델을 호출하지 않습니다.

검증 범위: 채널 권한·비밀번호·연결 취소, 중복 방지, 기록 개수, 전체 검증 단계, 자동 대화, 한도 지속성, 기억 분리·복원, QuickJS 격리, Python WASI 파일/환경/네트워크/쓰기/시간 제한, 실제 Codex 왕복. Claude/Grok/API/Docker는 해당 인증·설치가 있는 환경에서 추가 실호출 검사가 필요합니다.

공식 연결 참고: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [Grok headless](https://docs.x.ai/build/cli/headless-scripting).
