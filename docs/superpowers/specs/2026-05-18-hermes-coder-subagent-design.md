# Hermes Coder Sub-Agent Design

**Date**: 2026-05-18
**Owner**: bykim0119
**Status**: Draft (V1 scope agreed; pending implementation plan)
**Predecessor**: `project_acp_codex_orchestrator.md` (OpenClaw 시절 ACP+Codex 구성, 2026-05-05)

## 1. Purpose

메인 Hermes 에이전트의 컨텍스트와 turn loop를 가볍게 유지하기 위해, 코딩 작업을 **별도 Codex CLI 자식 프로세스(ACP child)** 로 위임한다. 자식은 자체 turn loop와 native file/terminal 도구를 사용하며, 진행 상황은 Discord 스레드에 격리되어 표시된다.

### 1.1 Why now

OpenClaw → hermes-agent 마이그레이션(2026-05-07, `project_migration_to_hermes_agent.md` Phase 5)에서는 "hermes 본체 두뇌가 이미 `openai-codex/gpt-5.4`이므로 ACP-Codex 우회 불필요"로 결론. 본 디자인은 그 결론을 **컨텍스트 분리** 관점에서 재검토한다:

- 메인 두뇌가 codex 모델이어도, 긴 코딩 turn loop가 메인 대화 컨텍스트를 채우면 일반 대화 품질/응답 속도가 떨어진다.
- 코더가 별도 프로세스에서 돌면 메인은 다른 사용자 메시지를 동시에 처리 가능 (async).
- Discord 스레드 분리로 메인 채널 잡음 회피.

## 2. Design decisions (확정)

| 항목 | 결정 |
|---|---|
| 코더 런타임 | Codex CLI을 ACP 자식으로 spawn (1차 A) / fallback `codex exec --json` (A1) |
| 트리거 | 자동 위임 (AGENTS.md 가이드) + 명시적 `/code <task>` slash command |
| 헷갈릴 때 default | 메인이 직접 답 (위임 비용 회피) |
| 실행 모드 | Background/async — 메인은 위임 즉시 turn 종료, 다른 메시지 처리 가능 |
| 출력 라우팅 | 새 Discord 스레드 자동 생성, 진행 이벤트는 스레드에만 publish |
| 진행 표시 | 이모지 prefix (`🔧 reading`, `✏️ editing`, `▶️ $`, `✅`, `⚠️`, `❌`, `📌`) |
| 스레드 follow-up | 같은 코더 세션 이어쓰기, 2시간 idle timeout |
| 메인 모델 | 변경 없음 (`gpt-5.4` 유지) |

## 3. Architecture

```
[#general 채널]                                  
User: "@Hermes src/foo.py에 X 함수 추가"
   │
   ▼
Hermes main (gpt-5.4, gateway turn loop)
   │ delegate_task_background(
   │   provider="copilot-acp",
   │   acp_command="codex",   # 또는 fallback A1 경로
   │   goal="...",
   │   context="...")
   │
   ├── [즉시 반환] → 메인 채널: "코더에게 위임 ▶ 스레드: 'foo.py에 X 함수 추가'"
   │                  새 스레드 자동 생성 (auto-archive 1440min)
   │
   └── detached asyncio task ──→ Codex CLI 자식 (gpt-5.3-codex, ACP stdio)
                                  │
                                  ▼
                                자체 turn loop + file/terminal tools
                                  │
                                  ▼ subagent_progress 이벤트
                                  │
                                  ▼
                                gateway router (coder_run_id → thread_id)
                                  │
                                  ▼
[▶ 스레드 'foo.py에 X 함수 추가']
🔧 reading src/foo.py
✏️ editing src/foo.py (+12 -3)
▶️ $ pytest tests/test_foo.py
✅ tests pass
✅ 완료 — foo.py:42 함수 X 추가, 테스트 5개 통과
```

메인은 위임 즉시 turn 종료 → 사용자가 메인 채널에서 다른 대화 진행 가능. 코더 출력은 스레드 안에서만 흐르므로 충돌 없음.

## 4. Components

### 4.1 신규/수정 코드

| # | 위치 | 변경 |
|---|---|---|
| 1 | `~/.hermes/config.yaml` | `delegation` 블록에 코더 프로파일 추가 (provider, acp_command, max_concurrent, idle_timeout 등) |
| 2 | `~/.hermes/.env` | `HERMES_COPILOT_ACP_COMMAND=codex`, `HERMES_COPILOT_ACP_ARGS=<verified args>` |
| 3 | `~/.hermes/hermes-agent/tools/delegate_tool.py` | 신규 tool `delegate_task_background`: 자식 spawn → 즉시 반환 (handle만), detached task로 코더 lifecycle 관리 |
| 4 | `~/.hermes/hermes-agent/gateway/platforms/discord.py` | (a) 위임 시 새 스레드 생성 hook, (b) `subagent_progress` 이벤트 콜백 확장 → 스레드 라우팅, (c) 250ms 디바운스 buffer, (d) 스레드 안 follow-up 메시지를 활성 코더 세션으로 라우팅 |
| 5 | `~/.hermes/hermes-agent/agent/copilot_acp_client.py` (또는 신규 client) | Codex CLI ACP 호환 검증; 미지원 시 `codex exec --json` 기반 신규 클라이언트 (A1 fallback) |
| 6 | hermes slash command 시스템 | `/code <task>` 등록 (thin wrapper → `delegate_task_background`) |
| 7 | `~/.hermes/workspace/AGENTS.md` | "🧑‍💻 Coding Delegation" 섹션 추가 — 코딩 작업 들어오면 자동 `delegate_task_background` 사용 가이드 |
| 8 | (선택) `~/.hermes/coder_sessions.json` | 활성 코더 세션 ↔ 스레드 매핑 영속화 (gateway 재시작 후 follow-up 지원용) |

### 4.2 재사용하는 기존 인프라

- `delegate_tool.py`의 `override_provider="copilot-acp"` + `override_acp_command`
- `copilot_acp_client.py`의 ACP stdio subprocess 패턴
- `DELEGATE_BLOCKED_TOOLS`(child 안전 가드)
- `_subagent_auto_deny`(dangerous 명령 자동 거부)
- `gateway/platforms/discord.py`의 `send_message(metadata={"thread_id": ...})` 라우팅
- `ThreadParticipationTracker`(스레드 안 follow-up은 mention 없이도 동작) — 코더 explicit 스레드도 생성 직후 tracker에 등록해야 함 (plan 단계 작업)
- `~/.codex/auth.json` OAuth(별도 셋업 불필요, 이전부터 동작)

## 5. Behavior specs

### 5.1 트리거

**자동 위임**: 사용자 메시지가 코드 작성/수정/실행/디버깅 요청이면 메인이 `delegate_task_background` 호출. 단순 코드 설명/리뷰는 메인이 직접 답한다. 헷갈리면 메인이 직접 답하고, 필요시 "/code로 강제할까?" 한 줄 묻기.

**명시 `/code <task>`**: 슬래시 인자 전체를 그대로 `delegate_task_background`에 forwarding. 메인 LLM 판단 우회. 이미 코더가 작업 중이어도 추가 spawn (병렬, 각자 새 스레드).

### 5.2 스레드 생성

`delegate_task_background` 호출 시 gateway hook가:
1. 부모 메시지에 attached 새 thread 생성
2. 이름 = goal에서 60자 이내 추출 (특수문자 sanitize)
3. auto-archive 1440min
4. thread_id를 coder_run_id에 묶고 `coder_sessions.json`(또는 in-memory map)에 저장

### 5.3 진행 이벤트 포맷

| Prefix | 의미 | 예 |
|---|---|---|
| 🔧 | 파일 읽기 | `🔧 reading src/foo.py` |
| ✏️ | 파일 수정 | `✏️ editing src/foo.py (+12 -3)` |
| ▶️ | 명령 실행 | `▶️ $ pytest tests/test_foo.py` |
| ✅ | 단계 성공 / 최종 완료 | `✅ tests pass` / `✅ 완료 — <요약>` |
| ⚠️ | 경고 | `⚠️ test took 12s (slow)` |
| ❌ | 실패 / 취소 | `❌ pytest failed: <line>` / `❌ 취소됨` |
| 📌 | 코더의 짧은 plan 메시지 | `📌 plan: edit foo.py → run tests` |

- 250ms 디바운스: 짧은 청크 모아 publish (Discord 초당 5 msg 제한 대응)
- 단일 메시지 cap 3500자, 초과 시 `…[truncated]` 추가 (OpenClaw 패턴)

### 5.4 종료

- 코더 성공 종료: 스레드 마지막에 `✅ 완료 — <한 줄 요약>`. 부모 채널 ping 없음 (V1).
- 실패: `❌ <에러 마지막 줄>`. 스레드는 그대로 둠 (사용자가 follow-up 가능).
- 스레드는 닫지 않음(Discord auto-archive 1440min에 맡김). 코더 세션 자체는 idle 2시간 후 backend에서 cleanup — 사용자 시점에선 스레드는 여전히 보이고 다음 메시지는 메인 LLM이 받음.

### 5.5 Follow-up

스레드 안 사용자 메시지(mention 없어도 `ThreadParticipationTracker`로 통과)는:
- 활성 코더 세션이 있으면 그 세션에 이어 전달 (ACP session resume 또는 신규 turn으로 계속)
- ACP session resume 미지원 시 새 세션 + 직전 thread N줄 (예: 마지막 10개 메시지) inject로 컨텍스트 보존
- 2시간 idle timeout 후 세션 종료. 이후 follow-up 메시지는 메인 LLM(Hermes)이 받아 일반 대화로 처리. (`/code`로 새 코더 spawn 가능)

### 5.6 취소

스레드 안 `stop`, `cancel`(대소문자 무관) 또는 `@Hermes stop` 메시지 → 코더 process 종료 + `❌ 취소됨` publish. V1은 단순 키워드 매칭. V2에 `/code cancel <id>` 검토.

### 5.7 동시성

- `delegation.max_concurrent` (default 3): 활성 코더 수 제한
- 초과 시 메인이 사용자에게 "활성 코더 3개 — 끝나는 거 기다리거나 하나 cancel해" 안내

## 6. Config sketch

`~/.hermes/config.yaml` (추가 블록):
```yaml
delegation:
  max_iterations: 50
  coder:
    provider: copilot-acp
    acp_command: codex
    model: gpt-5.3-codex   # ChatGPT Plus 제한, gpt-5.4-codex 불가
    fallback_mode: exec_json   # ACP 미지원 시 codex exec --json 경로
    max_concurrent: 3
    idle_timeout_seconds: 7200
    auto_deny_dangerous: true
    progress_debounce_ms: 250
    max_chunk_chars: 3500
```

`~/.hermes/.env`:
```
HERMES_COPILOT_ACP_COMMAND=codex
HERMES_COPILOT_ACP_ARGS=<plan 단계 검증 후 확정>
```

## 7. Scope

**V1 포함**:
- ACP 코더 spawn (1차 A, fallback A1)
- 자동 위임 (AGENTS.md) + `/code <task>`
- Background delegate (메인 free)
- 자동 스레드 생성 + 진행 이벤트 라우팅
- 이모지 prefix + rate-limit
- 스레드 안 follow-up = 같은 코더 세션 + 2시간 idle timeout
- 키워드 취소 (`stop`/`cancel`)
- max_concurrent 가드, dangerous 명령 자동 거부

**V1 제외** (필요시 별도 사이클):
- 부모 채널 ping
- `/code list`, `/code cancel <id>` 정식 slash
- 다른 코더 런타임 (Claude Code 등)
- 멀티 채널/cross-thread 컨텍스트 공유

## 8. Risks & mitigation

| 리스크 | 영향 | 완화 |
|---|---|---|
| Codex CLI가 ACP wire-protocol 직지원 안 함 | 경로 A 막힘 | Plan 1번 작업 = 검증; 실패 시 즉시 A1(`codex exec --json`)로 전환 |
| Codex ACP session resume 미지원 | follow-up = 매번 새 컨텍스트 | 새 세션 + 직전 thread 대화 N줄 inject로 완화 |
| `subagent_progress` 이벤트 빈약 | 스레드 진행 표시 안 됨 | Codex stdout 라인 캡처 + 자체 파싱 |
| AGENTS.md 가이드를 LLM이 무시 | 자동 위임 안 함 | `/code` 백업; 무시 패턴 보이면 V2에 키워드 라우터 추가 |
| Detached coder task 누수 | 메모리/프로세스 누적 | 2시간 idle timeout + max_concurrent cap + 명시적 cleanup |
| CJK chunk 공백/줄바꿈 깨짐 (OpenClaw 시절 학습) | 진행 메시지 깨짐 | Plan 테스트 케이스에 한국어 명시 |
| Discord rate-limit | 메시지 drop | 250ms 디바운스 + cap |
| 코더 위험 명령 자동 실행 | 데이터 손실 | `_subagent_auto_deny` 활성 (기본 동작) |
| Codex OAuth 만료 | 코더 spawn 실패 | 첫 spawn 시 expiry 체크, 만료면 스레드에 명확한 에러 + `codex login --device-auth` 안내 |

## 9. Implementation sequencing

1. **검증/스파이크** — Codex ACP 직지원 확인, fallback A1 결정, `subagent_progress` 이벤트 발화 확인. **여기서 결과에 따라 디자인 일부 재조정 가능.**
2. **코어 위임 경로** — `delegate_task_background` tool + ACP/exec 클라이언트 와이어링
3. **스레드 라우팅** — gateway에서 coder_run_id → thread_id 매핑 + send_message routing
4. **이벤트 → 진행 메시지** — 이모지 prefix 포맷 + 디바운스
5. **트리거** — `/code` slash 등록 + AGENTS.md 자동 위임 가이드 섹션
6. **Follow-up 세션** — thread 안 메시지 → 활성 코더 세션 라우팅 + 2시간 timeout
7. **취소/cleanup** — `stop`/`cancel` 키워드, max_concurrent, OAuth expiry handling
8. **테스트** — Discord 라이브: golden path(간단 코딩), edge(CJK, 긴 작업, 동시 2개, 취소, follow-up, OAuth 만료)

## 10. Open questions (plan 단계에서 해소)

- (C) hermes의 gateway run loop가 asyncio 기반인지 — detached task가 `asyncio.create_task` 한 줄로 되는지 vs ThreadPoolExecutor 분리 필요한지
- (D) Codex CLI ACP/exec-server/app-server 중 어떤 인터페이스가 가장 stream-friendly인지 (`codex exec --json` event 종류 매핑)
- (E) `coder_sessions.json` 영속화 필요 여부 — gateway 재시작 시 follow-up 끊겨도 OK인지

## 11. Related memos

- `project_acp_codex_orchestrator.md` — OpenClaw 시절 ACP+Codex 패턴 (predecessor)
- `project_migration_to_hermes_agent.md` Phase 5 — "ACP 우회 불필요" 결론을 본 디자인이 컨텍스트 분리 관점에서 재검토
- `project_hermes_discord_threads.md` — 기존 `DISCORD_AUTO_THREAD` 인프라 (본 디자인은 explicit 코더-전용 스레드로 별도 경로)
- `project_setup.md` — hermes 모델 (`gpt-5.4`) / Codex OAuth 상태
