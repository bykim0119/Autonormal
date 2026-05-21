# AGENTS.md V2 — Coding Delegation Guidance Redesign

**Author**: bukim
**Date**: 2026-05-21
**Status**: design (approved, ready for implementation plan)
**Affects**: `~/.hermes/workspace/AGENTS.md` (workspace bootstrap file read by every hermes session)
**Related**: hermes-coder-subagent plan (2026-05-18), Task 13 e2e walkthrough (commit `7a32d2cfc`)

## Background

Task 13 Scenario 1 surfaced the V1 weakness: the parent agent picked
`write_file` directly for "한 줄 print 추가하고 호출도 해줘" instead of
delegating to the coder. Same outcome was observed during Task 9 smoke
runs but accepted as a V1 trade-off. With Task 11+12 hardening
(cancellation, config, auth pre-check) shipped, the inconsistency is
now the largest remaining quality gap.

User's stated reason for caring:
> 코더 컨텍스트 분리 & 전문성이야. 간단한 작업은 상관없지만, 복잡한 것은
> 컨텍스트 오염과 작업 성능이 떨어지니까. 그런데 write_file 자체에 제약이
> 들어가면 tool에 대한 접근 자체를 막아버릴 수 있어서 조심스러워.

So:
* Trivial in-turn is **fine**.
* Complex in-turn **pollutes main context** + loses coder specialization.
* `write_file` tool removal is **too aggressive** — keep it available.

V1 problems:
1. Trigger list (`X 파일 만들어/추가해/수정해`) was too abstract; LLM
   ignored it for a literal "파일 추가" request.
2. "위임 안 함" list and trigger list overlapped (a 한 줄 print could
   be read as "한 줄 syntax 질문" depending on framing).
3. "헷갈리는 경계 케이스 → main bias" actively pushed the LLM toward
   in-turn whenever uncertainty existed.

## Approach

**Selected**: A' — AGENTS.md-only revision with explicit role split
between `delegate_task` and `delegate_task_background`. No toolset
surgery. (`delegate_task` is upstream-provided general-purpose
delegation, not coder-specific; removing it would break non-coding
delegation and widen our fork.)

Rejected alternatives:
* **C (delegate_task removal)** — too invasive; `delegate_task` is
  upstream and serves non-coding subagent spawns.
* **B (complexity marker list)** — same drift risk as V1; adding more
  abstract markers doesn't fix abstract matching.

## Design

### 1. Core Rule

Replace V1's trigger list with a single self-verifiable rule:

> **작업을 완료하려면 도구를 2회 이상 호출해야 하는가?**
> - 예 (read→edit, edit→verify, test→iterate, 여러 파일, debug-loop)
>   → `delegate_task_background`
> - 아니오 (단발성 write_file 1회, 또는 응답만) → in-turn OK
>
> 자기검증 질문: "이 작업을 완료하려면 read_file을 먼저 해야 하나?
> terminal로 실행해서 결과를 확인해야 하나? write_file을 두 번 이상
> 해야 하나?" → yes면 위임.

The "2+ tool calls" indicator is concrete enough to avoid the semantic
matching that failed V1.

### 2. Boundary Bias Reversal

V1: "헷갈리면 main으로 bias" — root cause of the Scenario 1 failure.

V2:

> **헷갈리면 위임**으로 bias.
>
> 비용 비대칭:
> * 위임이 잘못된 선택일 때 = thread 하나 추가 + 약간의 사용자 인지 부담
> * in-turn이 잘못된 선택일 때 = main 컨텍스트 오염, 작업 성능 저하,
>   감사 기록 부재
>
> in-turn 비용 > 위임 비용. 경계 케이스는 위임 쪽으로.

V1의 `/code <요청>` 안내는 더 이상 1차 옵션으로 제시하지 않음. `/code`
경로는 그대로 살아있지만 AGENTS.md에서 escape hatch처럼 광고하지
않음.

### 3. Boundary Examples + 분석 예외

| 사용자 요청 | 판정 | 이유 |
|---|---|---|
| "한 줄 print 추가" | in-turn OK | write_file 1회 |
| "함수 X 추가하고 호출도 넣어줘" | **위임** | read → edit → verify (multi-step) |
| "이 파일에서 OAuth 부분 5줄 설명해줘" | in-turn OK | read 1회 + 답변, 변경 없음 |
| "에러 메시지 보고 고쳐줘" | **위임** | read → 진단 → edit → 재실행 |
| "테스트 작성하고 통과시켜줘" | **위임** | write → run → iterate |
| "이 한 줄 syntax 맞아?" | in-turn OK | 응답만 |
| "여러 파일에 같은 import 추가" | **위임** | 여러 파일 = multi-step |
| "리팩토링/이름 변경/모듈 정리" | **위임** | 항상 multi-step |
| "내가 방금 만든 파일 살짝만 수정 (1줄)" | in-turn OK | 사용자가 명시적으로 단일 변경 |

**수정 없는 분석/탐색 예외**:

핵심 룰("2+ 도구 = 위임")은 *수정 없는 분석*에는 적용 안 됨. 분석은
사용자와의 **대화의 일부**이므로 main이 직접 처리. 사용자 follow-up과
연결되어야 하니까.

| 요청 | 판정 | 이유 |
|---|---|---|
| "이 함수 어떻게 작동하는지 설명해줘" | in-turn | 답변 = 채널 메시지, 대화 흐름 |
| "OAuth 부분 코드 분석" | in-turn | 분석 결과 → main이 직접 답해야 follow-up |
| "전체 모듈 구조를 markdown으로 /tmp/analysis.md에 정리" | **위임** | deliverable이 파일 |
| "버그 찾아서 고쳐줘" | **위임** | 분석 + 수정 (수정 들어가면 coder) |

**기준 한 줄**: 수정 또는 파일 산출물이 있나? 있으면 coder, 없으면 main.

### 4. 사용자 명시 Override + Escalation

> **사용자 명시 지시가 룰을 override**.
>
> in-turn 명시 트리거 예시:
> - "thread 말고 직접 고쳐줘"
> - "그냥 빠르게 수정해"
> - "분석한 결과 보고 같이 고치자"
> - "코더 말고 네가 해"
>
> 반대로 사용자가 "코더로 보내줘", "thread에서 처리해줘"라고 하면
> trivial 작업도 **위임**.
>
> 명시 신호 없을 때만 룰(섹션 1~3) 적용.

**복잡도 초과 안내** (in-turn으로 시작했지만 작업이 부풀어 오를 때):

> in-turn 작업이 도구 호출 **5회 이상**에 도달하면 사용자에게 한 줄:
> > "이 작업이 예상보다 복잡해지고 있습니다. 코더로 넘기시겠어요? `/code <요청>`"
>
> 안내만 출력. 응답 기다리지 말고 현재 도구 호출은 계속. 사용자가 다음
> 메시지에서 코더 명시 요청 시 그때 위임.

### 5. delegate_task vs delegate_task_background 역할 분리

| 도구 | 용도 | 결과 경로 |
|---|---|---|
| `delegate_task` (sync) | **비-코딩 위임**: 리서치, 분석, 멀티스텝 일반, 외부 정보 수집 | main이 받아 채널에 답변 (max 24K 토큰) |
| `delegate_task_background` (async) | **코딩 작업 전용**: 파일 수정, 디버깅, 테스트, 리팩토링, 빌드 실행 | 자동 생성된 Discord thread |

**코딩에 `delegate_task` 절대 쓰지 말 것** — sync 위임은 결과가 main으로
돌아오고, 자식이 만든 파일/실행 결과를 thread로 보낼 채널이 없어 main
컨텍스트 오염 + 가시성 손실 + cancel 같은 코더 인프라 못 씀.

**비-코딩에 `delegate_task_background` 절대 쓰지 말 것** — codex CLI는
코딩 환경(workspace, sandbox, file ops)에 맞춰져있고, 리서치/일반
작업에 부적합.

### 6. V1에서 유지할 것들

(트리거 룰만 V2로 교체. 호출 패턴 + do/don't는 그대로 잘 작동 중.)

* **호출 패턴**: `delegate_task_background(goal=..., context=...)` 한 번만.
  `goal`은 자기완결적 1줄, `context`는 파일 경로/에러/제약 간결히.
* **호출 직후 응답 한 줄**: "▶ 코더에게 위임 — 진행은 자동 생성된 스레드 참조"
* **위임 후 안티패턴 (하지 말 것)**:
  * 자기 도구로 같은 작업 중복 실행 ❌
  * 폴링 (`for i in $(seq 1 20); do ...`) ❌
  * thread URL/run_id 만 던지기 ❌
* **위임 후 정상 동작 (할 것)**:
  * 본 채널 다른 대화 자연스럽게 계속
  * "코더 진행?" → "스레드 확인 가능" 한 줄 또는 `active_subagents` 호출
  * 코더 완료 시 별도 ping 안 함 (thread 알림으로 충분)
* **Codex 환경 메모**: sandbox `danger-full-access`, `CodexExecFacade`
  → NDJSON → thread

### 7. Migration

1. 백업: `cp ~/.hermes/workspace/AGENTS.md ~/migration-backups/agents-md-v2-${timestamp}.bak`
2. `## 🧑‍💻 Coding Delegation` 섹션 (현재 line 132~181)을 V2로 교체
3. 게이트웨이 재시작 불필요 — AGENTS.md는 workspace bootstrap 파일이라
   자식 spawn 시 매번 읽힘 (단, parent agent 컨텍스트가 이미 시작된
   경우 다음 turn부터 적용)
4. **라이브 검증** — Scenario 1 재실행:
   `@Hermes /tmp/scratch_e2e_v2.py에 hello world 한 줄 print 추가하고 호출도 해줘`
   * 기대: parent가 `delegate_task_background` 호출 (multi-step rule
     적용; "추가하고 호출도 추가"는 read→edit 또는 write→verify가 자연스러우니 multi-step)
   * 실패 시 (다시 write_file로 떨어지면): 룰 표현이 여전히 약한 것 →
     V3 후속 (예: 명시 예시를 더 강하게 또는 toolset rebrand)

## Testing

자동 테스트 없음 — AGENTS.md는 prompt-engineering 영역, 결정성 보장
불가. **라이브 검증만**.

검증 체크리스트:
* [ ] Scenario 1 재실행 → 위임 발생 (PASS) 또는 in-turn (FAIL)
* [ ] 새 시나리오: "이 함수 설명해줘" → in-turn 유지되는지 (수정 없는 분석 예외)
* [ ] 새 시나리오: "thread 말고 직접 고쳐줘 — `~/tmp/foo.py`에 print('x') 추가" → in-turn (override)

V1에서 잘 되던 시나리오 (`/code`, follow-up, cancel, 자연어 위임 시 정상 동작)는 V2가 회귀시키면 안 됨.

## Out of Scope

* `toolsets.py` 수정 (`delegate_task` 제거 등) — 본 V2의 의도된 제약.
* `_HERMES_CORE_TOOLS` 변경.
* AGENTS.md 외 다른 시스템 프롬프트 영역 수정.
* AGENTS.md V3 (자동화된 a/b 시험, 룰 결정성 강화) — 별도 시즌.

## Open Questions

없음 — 디자인 사용자 승인 완료.
