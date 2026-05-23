# Coder Fork Isolation — Design Spec

- **작성일**: 2026-05-23
- **상태**: 검증 완료, 구현 plan 작성 직전
- **관련 메모**: `project_hermes_fork_isolation`, `project_hermes_coder_subagent`
- **관련 브랜치**: `feature/coder-subagent` (`/home/bykim0119/.hermes/hermes-agent`)

## 1. 배경

코더 서브에이전트(`feature/coder-subagent`)는 master 대비 **24 commits, 3,496 추가 / 22 삭제**. 분기점 2026-05-08 이후 upstream(NousResearch/hermes-agent)이 **2주에 1,439 commits** 진행. 우리가 수정한 10개 inline 파일이 전부 upstream 핫스팟이라 fork drift 비용이 누적될 위험.

가장 큰 폭탄은 upstream commit `cc8e5ec2a` — Discord adapter를 `gateway/platforms/discord.py`(5,101 LOC)에서 `plugins/platforms/discord/adapter.py`로 이주시킨 리팩토링. 우리의 `gateway/platforms/discord.py +415 LOC` 패치 전체가 이 변경 위에 떠 있음.

## 2. 목표

1. **upstream 머지 비용 최소화**: 평상시 0에 수렴, worst case 1~3일.
2. **잔존 inline 10라인 미만**: 현재 1,073 라인이 흩어진 변경을 단일 `plugins/subagent_coder/` 패키지로 수렴 (100배+ 감소). Open Items 검증 결과에 따라 0~11 범위.
3. **단기 운영 + 장기 미정 시나리오 양쪽에 깨끗**: 영구 fork가 되든 upstream PR로 가든, 분리 단위 그대로 재사용 가능해야 함.
4. **현 기능 회귀 0**: 자연어 위임, `/code`, follow-up, `!cancel`, V2 AGENTS.md 모든 라이브 시나리오 PASS 유지.

## 3. Non-goals

- 코더 자체 기능 확장 (V3, D 리팩토링 등)은 별도 시즌.
- AGENTS.md V2의 한계(`single write_file로 압축 가능한 작업이 in-turn`) 해소는 별도 작업.
- hermes-agent의 일반 plugin API 개선 — upstream PR 시도는 보너스 트랙으로 분리.

## 4. 검증 결과 요약

세 가지 30분 검증을 brainstorming 단계에서 마침. 자세한 데이터 ↦ `project_hermes_fork_isolation`.

| # | 검증 항목 | 결과 |
|---|---|---|
| 1 | Agent loop `delegate_task_background` elif 외부화 가능한가 | ✅ `tools/delegate_tool.py:2783`의 upstream `registry.register` handler가 `**kw`로 `parent_agent`를 자동 전달. inline elif 두 군데 모두 제거 가능. **이전 메모 정정**: "registry handler는 parent_agent 못 주입"은 틀린 인식이었음. |
| 2 | Plugin loading order — `discord`보다 우리가 먼저 로드되는지 | ⚠ `hermes_cli/plugins.py:1339 sorted(self._plugins.items())` 발견. 알파벳 정렬 거의 확실. 우회: plugin name을 `subagent_coder` ('s' > 'd')로. |
| 3 | Discord adapter 확장의 정통 path | ✅ `gateway/platform_registry.py:94 get(name)` + `PlatformEntry.adapter_factory` 노출. **factory wrap이 정통** (클래스 monkey-patch 불필요). `DiscordAdapter._client: commands.Bot`이라 `add_listener`/`tree.add_command` 정식 지원. |

## 5. 아키텍처

### 5.1 패키지 구조

```
plugins/subagent_coder/
├── __init__.py                  # register(ctx) — 모든 wire의 단일 진입점
├── plugin.yaml
├── codex_exec_client.py         ← agent/codex_exec_client.py 이동
├── codex_exec_facade.py         ← (현 client에서 분리)
├── coder_sessions.py            ← gateway/coder_sessions.py 이동
├── coder_progress_formatter.py  ← gateway/coder_progress_formatter.py 이동
├── coder_event_bus.py           ← gateway/coder_event_bus.py 이동
├── coder_config.py              ← gateway/coder_config.py 이동
├── delegate_background.py       ← tools/delegate_tool.py +434 LOC 추출
├── discord_overlay.py           ← gateway/platforms/discord.py +415 LOC 추출
└── codex_provider.py            ← plugins/model-providers/codex-exec/ 흡수
```

원본 6개 신규 파일 + 2개 큰 inline 추출 + 1개 model provider plugin 통합 → **단일 패키지**.

### 5.2 `register(ctx)` 책임

`plugins/subagent_coder/__init__.py:register(ctx)`가 다음을 모두 wire:

1. **Tool registry 등록**: `delegate_task_background`를 `registry.register(handler=lambda args, **kw: ..., parent_agent=kw.get("parent_agent"))` 패턴으로 — agent loop inline elif 불필요.
2. **Toolset entry 추가**: `_HERMES_CORE_TOOLS`에 `delegate_task_background` 동적 추가 (없으면 plugin이 list.append).
3. **Codex-exec provider 등록**: `HermesOverlay`의 model provider 슬롯에 `codex-exec` 등록. `_EXTERNAL_PROCESS_DEFAULTS.update({"codex-exec": {...}})`로 분기 외부화.
4. **AIAgent slot 추가**: `setattr(AIAgent, "coder_spawn_callback", None)` — 또는 가능하면 `AIAgent.__init__` wrap으로 인스턴스 attribute 초기화. 자세한 결정은 구현 단계 grep으로.
5. **Discord adapter factory wrap**:
   ```python
   entry = platform_registry.get("discord")
   if entry is None:
       logger.warning("subagent_coder: discord platform not registered, skipping overlay")
       return
   orig_factory = entry.adapter_factory
   def wrapped_factory(cfg):
       adapter = orig_factory(cfg)
       discord_overlay.install(adapter)
       return adapter
   entry.adapter_factory = wrapped_factory
   ```
6. **Credentials resolver hook**: `hermes_cli/auth.py`의 `resolve_external_process_provider_credentials`를 plugin이 등록하는 형태로 흡수 (가능 여부는 grep 검증).

### 5.3 `discord_overlay.install(adapter)`

adapter 인스턴스가 생성된 직후 호출 (factory wrap에서). 다음을 설치:

- `adapter._coder_sessions = CoderSessionManager(...)`
- `adapter._coder_flusher = DebouncedFlusher(...)`
- 메서드 attach: `on_coder_event`, `create_coder_thread`, `_handle_code_slash`, `_handle_coder_followup`, `_cancel_coder_run`, `_publish_to_thread`, `_make_thread_name`.
- `adapter.connect()` wrap 또는 adapter가 노출하는 post-connect hook 사용:
  - `adapter._client.add_listener(coder_message_filter, "on_message")` ← thread follow-up + `!cancel` 가로채기
  - `adapter._client.tree.add_command(_code_slash_cmd)` ← `/code` 등록
- `coder_event_bus` 구독 등록 — 코더 이벤트 → adapter.on_coder_event 디스패치.

### 5.4 잔존 inline 명세

| 파일 | 현재 | 목표 | 비고 |
|---|---|---|---|
| `gateway/platforms/discord.py` (구) | 415 | **0** | upstream에서 `plugins/platforms/discord/adapter.py`로 이주 — 우리는 손도 안 댐 |
| `tools/delegate_tool.py` | 434 | **0~1** | plugin이 registry.register, import 1줄만 가능 |
| `gateway/run.py` | 29 | **0** | progress_callback의 subagent_progress 분기는 plugin이 callback을 register하는 형태로 외부화 |
| `run_agent.py` | 73 | **0~5** | 검증 1로 elif 제거. `coder_spawn_callback` slot만 잔존 가능 |
| `agent/auxiliary_client.py` | 28 | **0** | plugin register에서 `_EXTERNAL_PROCESS_DEFAULTS.update(...)` |
| `hermes_cli/auth.py` | 84 | **0~5** | credential resolver hook이 plugin-friendly한지 grep 후 결정 |
| `hermes_cli/providers.py` | 6 | **0** | codex-exec provider plugin이 처리 |
| `toolsets.py` | 4 | **0** | plugin register에서 toolset list mutate |
| `plugins/model-providers/codex-exec/*` | 신규 40 | (subagent_coder 안으로 흡수) | 단일 패키지화 |
| **합계** | **1,073** | **0~11** | |

## 6. 마이그레이션 단계 (high-level)

자세한 plan은 다음 turn에 `writing-plans`으로. 여기서는 단계 윤곽만.

| Step | 작업 | 위험 | 시간 |
|---|---|---|---|
| 0 | Spec 단계 grep 3건: plugin 정렬 키 / 다른 plugin naming 컨벤션 / `_HERMES_CORE_TOOLS` 동적 mutate 가능성 | 0 | 30m |
| 1 | 신규 6개 파일을 `plugins/subagent_coder/`로 이동 + import 경로 수정 + `plugin.yaml` 작성 | 낮음 | 1~2h |
| 2 | `delegate_task_background` 핵심 로직을 `delegate_background.py`로 추출, plugin register가 `registry.register` 호출 | 중 (handler 시그니처 검증 필요) | 2~4h |
| 3 | `_EXTERNAL_PROCESS_DEFAULTS` + credential resolver + provider 등록을 plugin register로 통합 | 중 | 1~2h |
| 4 | Discord overlay 구현 — factory wrap + `discord_overlay.install` + listener/tree 등록. 라이브 smoke. | 높음 (lifecycle 타이밍) | 4~8h |
| 5 | `run_agent.py +73` 잔존 검증·축소. `coder_spawn_callback` slot wire. | 낮음 | 1h |
| 6 | 라이브 smoke 4종 (자연어 위임 / `/code` / follow-up / `!cancel`) + V2 AGENTS.md 보존 확인 | - | 2h |
| **합계** | | | **2~3일 집중 / 4~5일 분산** |

## 7. 운영 비용 (1년 누적 추정)

| | 평상시/회 | worst 1회 | 1년 누적 |
|---|---|---|---|
| **본 spec (P1)** | **0** | 1~3일 (adapter lifecycle 변경) | **5~15h** |
| (참고) 현 상태 유지 (A) | 1~3h | 1~2주 | 50~80h |
| (참고) Fallback C (file fork) | 30m~2h | 1~3일 | 15~30h |

## 8. 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| `_HERMES_CORE_TOOLS`가 immutable / register 시점에 mutate 불가 | 잔존 inline 늘어남 | Step 0 grep 결과에 따라 list 직접 mutate 또는 plugin이 별도 toolset 만들기 |
| Discord adapter `_client` 생성 시점이 `__init__` 밖 (예: `connect()`)이라 factory wrap만으로는 listener 등록 불가 | `discord_overlay.install`이 lifecycle 추적 필요 | adapter에 post-connect callback 등록 메커니즘 grep. 없으면 `adapter.connect`를 wrap. |
| Plugin loading order 정렬 키가 디렉터리 path | `subagent_coder` 이름으로 부족 | spec 단계에서 grep 후 확정. 필요 시 plugin.yaml `name` 명시. |
| `parent_agent` kw 전달이 일부 codepath에서만 작동 | delegate_task_background가 일부 환경에서 실패 | Step 2 라이브 smoke로 검증. 깨지면 `tool_progress_callback` chain으로 우회 가능. |
| upstream이 `commands.Bot`을 raw `discord.Client`로 바꿈 | `add_listener`/`tree.add_command` 깨짐 | 발생 시 fallback C (file fork). 발생 빈도 낮을 것으로 예상 (discord.py commands extension은 사실상 표준). |

## 9. Open Items (Step 0에서 grep으로 확정)

1. **Plugin 정렬 키**: `_plugins.items()`의 key가 plugin.yaml `name` 필드인지 디렉터리 path인지.
2. **Naming 컨벤션**: 기존 plugin들이 `topic_*` 같은 prefix 컨벤션을 따르는지 (예: `platforms/`, `model-providers/`).
3. **`_HERMES_CORE_TOOLS` mutate 가능성**: register 시점에 list.append이 작동하는지, 아니면 frozen인지.
4. **Adapter post-connect hook**: `BasePlatformAdapter`가 노출하는 lifecycle 콜백 중 `_client` 생성 후 시점이 있는지.
5. **Credential resolver hook**: `resolve_external_process_provider_credentials`가 plugin-friendly한 등록 메커니즘이 있는지, 아니면 inline patch 필요한지.

Step 0 30분 안에 (1)~(5) 확정. 결과에 따라 Step 1~6 세부 조정.

## 10. 병행 트랙 (보너스)

본 spec 외부:

- **P3 — Upstream PR**: NousResearch에 plugin 의존성 선언 / post-discovery hook / adapter extension hook 중 하나를 contribute. 받아지면 `subagent_coder` 명명 hack 제거 가능. baseline에는 영향 없는 별도 트랙.

## 11. 후속

본 spec 승인 후:
1. `writing-plans` 스킬로 implementation plan 작성: `docs/superpowers/plans/2026-05-23-coder-fork-isolation.md`. Step별 task + RED→GREEN TDD cycle 명시 ([[feedback_tdd_first]] 준수).
2. 구현은 `feature/coder-subagent` 위에 새 commit 시리즈로. 끝나면 동일 브랜치에서 master rebase 1회 dry-run 해서 실제 머지 비용 baseline 측정.
3. 라이브 smoke 4종 통과 + V2 AGENTS.md 회귀 0 확인.
4. (선택) P3 PR 작성 — 별도 작업.
