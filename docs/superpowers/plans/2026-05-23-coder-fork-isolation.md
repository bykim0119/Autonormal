# Coder Fork Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코더 서브에이전트 24 commits(1,073 inline 라인)를 단일 `plugins/subagent_coder/` 패키지로 격리해 hermes-agent upstream 머지 비용을 0~11 라인 수준으로 압축.

**Architecture:** hermes-agent의 plugin system + `platform_registry.adapter_factory` wrap + `registry.register(**kw)` handler를 활용한 in-place 외부화. Discord adapter 본체는 손대지 않고, plugin이 `register(ctx)` 시점에 모든 hook을 wire한다. monkey-patch 최소화, factory wrap 우선.

**Tech Stack:**
- Python 3.11+, pytest, hermes-agent plugin system
- discord.py `commands.Bot` (add_listener, tree.add_command)
- Codex CLI 0.121.0 (`codex exec --json --skip-git-repo-check`)
- 기존 코더 모듈 (codex_exec_client, coder_sessions, coder_progress_formatter, coder_event_bus, coder_config, delegate_background)

**관련 문서:**
- Spec: `docs/superpowers/specs/2026-05-23-coder-fork-isolation-design.md`
- 이전 plan: `docs/superpowers/plans/2026-05-18-hermes-coder-subagent.md`

**Working dir:** `/home/bykim0119/.hermes/hermes-agent` (브랜치 `feature/coder-subagent`)

**Strategy notes (반드시 따를 것):**
- TDD RED→GREEN 글자대로 ([[feedback_tdd_first]] 메모). 모든 신규 동작은 실패하는 테스트부터.
- 커밋은 작게 자주. Step별 커밋 단위 명시.
- 기존 308+ 회귀 테스트가 매 Task 끝에 통과해야 함. 깨지면 즉시 fix → commit.
- 라이브 smoke는 Task 9에 모았지만, Task 4·7의 큰 변경 직후 mini-smoke (코더 1회 spawn) 권장.

---

## Task 0: Pre-flight Grep — Spec Open Items 5건 확정

**왜**: Spec Section 9의 미확정 가정 5개를 grep으로 확정해야 Task 1~ 결정이 정확해짐. 결과를 본 plan 안에 inline으로 채워 후속 Task가 참조.

**Files (read-only):**
- `hermes_cli/plugins.py` (loader)
- `gateway/platform_registry.py` (already inspected)
- 임의 plugin.yaml 샘플 (`plugins/platforms/teams/plugin.yaml` 등)
- `agent/toolsets.py` 또는 `toolsets.py`
- `gateway/platforms/base.py` (BasePlatformAdapter)
- `hermes_cli/auth.py`

**Working dir:** `/home/bykim0119/.hermes/hermes-agent`

- [ ] **Step 0.1: Plugin 정렬 키 확인 (Open Item 1a)**

Run:
```bash
grep -n "sorted\|_plugins\[" hermes_cli/plugins.py | head -20
sed -n '780,820p' hermes_cli/plugins.py  # discover_and_load 영역
sed -n '1160,1200p' hermes_cli/plugins.py  # _load_plugin 영역
```
**확인할 것**: `self._plugins` dict의 key가 plugin.yaml `name` 필드인지, 디렉터리 path인지, manifest 식별자인지.

- [ ] **Step 0.2: plugin.yaml label/description 필드 지원 (Open Item 1b)**

Run:
```bash
cat plugins/platforms/teams/plugin.yaml
cat plugins/platforms/irc/plugin.yaml
cat plugins/platforms/discord/plugin.yaml
grep -rn "label\|display_name\|description" plugins/platforms/*/plugin.yaml | head -20
```
**확인할 것**: `label`, `display_name`, `description` 중 어느 게 표준인지. PluginManifest dataclass 노출 필드.

- [ ] **Step 0.3: `_HERMES_CORE_TOOLS` mutate 가능성 (Open Item 3)**

Run:
```bash
grep -n "_HERMES_CORE_TOOLS\|TOOLSETS\[" toolsets.py agent/toolsets.py 2>/dev/null | head -30
grep -rn "_HERMES_CORE_TOOLS" --include="*.py" | head -20
```
**확인할 것**: list/tuple/frozenset 중 무엇인지. plugin register 시점에 list.append이 가능한지.

- [ ] **Step 0.4: Adapter post-connect hook (Open Item 4)**

Run:
```bash
grep -n "on_ready\|post_connect\|after_start\|connect\b" gateway/platforms/base.py | head -20
sed -n '1290,1360p' gateway/platforms/base.py  # BasePlatformAdapter 본체
```
**확인할 것**: adapter `_client` 생성 후 호출되는 lifecycle 콜백이 있는지. 없으면 `connect()` wrap 필요.

- [ ] **Step 0.5: Credential resolver hook (Open Item 5)**

Run:
```bash
grep -n "_EXTERNAL_PROCESS_DEFAULTS\|resolve_external_process_provider_credentials" hermes_cli/auth.py agent/auxiliary_client.py
sed -n '/_EXTERNAL_PROCESS_DEFAULTS/,+30p' hermes_cli/auth.py | head -50
```
**확인할 것**: defaults dict가 module-level mutable인지. 외부에서 `.update(...)` 호출이 안전한지.

- [ ] **Step 0.6: 결과를 본 plan에 inline으로 기록**

이 plan 파일 Task 0 끝에 "결과" 섹션 추가하고 5개 결과 1줄씩 적기. 후속 Task에서 분기 결정 시 참조.

- [ ] **Step 0.7: Commit verification notes**

```bash
git add docs/superpowers/plans/2026-05-23-coder-fork-isolation.md  # in autonormal repo
git -C /home/bykim0119/autonormal commit -m "docs(plan): record fork isolation pre-flight grep results"
```

**Task 0 결과 (Step 0.6에서 채울 것):**
- 0.1 정렬 키: ___
- 0.2 user-facing 필드: ___
- 0.3 _HERMES_CORE_TOOLS mutate 가능: ___
- 0.4 post-connect hook: ___
- 0.5 credential defaults mutable: ___

---

## Task 1: `plugins/subagent_coder/` 패키지 스켈레톤

**왜**: 후속 Task가 이 패키지로 코드를 이동/추출. 빈 패키지부터 register(ctx) skeleton까지 먼저 깐다.

**Files:**
- Create: `plugins/subagent_coder/__init__.py`
- Create: `plugins/subagent_coder/plugin.yaml`
- Create: `tests/plugins/test_subagent_coder_skeleton.py`

- [ ] **Step 1.1: Write failing test for plugin discovery**

`tests/plugins/test_subagent_coder_skeleton.py`:
```python
"""Skeleton: plugin은 발견되고 register(ctx)가 callable이어야 한다."""
import importlib

def test_subagent_coder_module_importable():
    mod = importlib.import_module("plugins.subagent_coder")
    assert hasattr(mod, "register"), "register entry point 누락"
    assert callable(mod.register)

def test_plugin_yaml_exists_with_required_fields():
    from pathlib import Path
    import yaml
    p = Path(__file__).resolve().parents[2] / "plugins/subagent_coder/plugin.yaml"
    assert p.exists(), f"plugin.yaml not found at {p}"
    data = yaml.safe_load(p.read_text())
    assert data.get("name") == "subagent_coder"
    # label/description 필드: Step 0.2 결과에 따라 키 이름 조정
```

- [ ] **Step 1.2: Run test — FAIL**

Run:
```bash
cd /home/bykim0119/.hermes/hermes-agent
pytest tests/plugins/test_subagent_coder_skeleton.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'plugins.subagent_coder'`

- [ ] **Step 1.3: Create plugin.yaml**

`plugins/subagent_coder/plugin.yaml`:
```yaml
name: subagent_coder
label: "Codex Coder Sub-Agent (Discord)"
description: |
  Background coding delegation via Codex CLI.
  Spawns ``codex exec`` subprocess in a daemon thread and routes
  live progress to the platform UI.
  Currently integrates with Discord; core is platform-agnostic.
```
> Step 0.2 결과로 label 키가 다르면 그에 맞춰 조정. `label` 미지원 시 description만.

- [ ] **Step 1.4: Create `__init__.py` with register skeleton**

`plugins/subagent_coder/__init__.py`:
```python
"""subagent_coder plugin — Codex CLI 기반 코더 서브에이전트.

Wires:
- delegate_task_background tool (registry.register with parent_agent kw)
- codex-exec model provider
- Discord platform overlay (factory wrap)
- AIAgent.coder_spawn_callback slot

자세한 설계: docs/superpowers/specs/2026-05-23-coder-fork-isolation-design.md
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Plugin entry point — Hermes plugin system이 로드 시 호출."""
    logger.info("subagent_coder: register(ctx) started")
    # Task 2~8에서 각 wire를 차례로 추가.
    logger.info("subagent_coder: register(ctx) complete (skeleton)")
```

- [ ] **Step 1.5: Run tests — PASS**

Run:
```bash
pytest tests/plugins/test_subagent_coder_skeleton.py -v
```
Expected: PASS (2/2)

- [ ] **Step 1.6: Commit**

```bash
cd /home/bykim0119/.hermes/hermes-agent
git add plugins/subagent_coder/ tests/plugins/test_subagent_coder_skeleton.py
git commit -m "feat(subagent_coder): scaffold plugin package + register skeleton

Empty plugin package as the destination for fork isolation migration.
register(ctx) stub will be filled by subsequent tasks."
```

---

## Task 2: 신규 코더 코어 6개 파일 이동

**왜**: 코어 모듈(platform-agnostic)을 `plugins/subagent_coder/` 안으로 옮긴다. 기존 테스트가 새 경로에서도 통과해야 함.

**Files to move:**
- `agent/codex_exec_client.py` → `plugins/subagent_coder/codex_exec_client.py`
- `gateway/coder_sessions.py` → `plugins/subagent_coder/coder_sessions.py`
- `gateway/coder_progress_formatter.py` → `plugins/subagent_coder/coder_progress_formatter.py`
- `gateway/coder_event_bus.py` → `plugins/subagent_coder/coder_event_bus.py`
- `gateway/coder_config.py` → `plugins/subagent_coder/coder_config.py`
- (CodexExecFacade가 codex_exec_client에 포함되어 있으면 같이 이동)

**Files to modify (import 경로 업데이트):**
- 기존 caller들 (run_agent.py, auxiliary_client.py, tools/delegate_tool.py, gateway/run.py, gateway/platforms/discord.py)
- 기존 테스트 (tests/agent/test_codex_exec_client.py, tests/gateway/test_coder_*.py)

- [ ] **Step 2.1: 한 파일씩 이동 (codex_exec_client 먼저)**

```bash
cd /home/bykim0119/.hermes/hermes-agent
git mv agent/codex_exec_client.py plugins/subagent_coder/codex_exec_client.py
```

- [ ] **Step 2.2: 모든 import 업데이트 — codex_exec_client**

Run:
```bash
grep -rln "from agent.codex_exec_client\|import agent.codex_exec_client" --include="*.py"
```
각 file의 import를 `from plugins.subagent_coder.codex_exec_client` / `from plugins.subagent_coder import codex_exec_client`로 치환.

- [ ] **Step 2.3: Run test — codex_exec_client 테스트 PASS 확인**

```bash
pytest tests/agent/test_codex_exec_client.py -v
```
Expected: 모두 PASS (이동만 했으므로). FAIL이면 import 누락 → fix.

- [ ] **Step 2.4: 테스트 위치도 이동 (선택)**

```bash
git mv tests/agent/test_codex_exec_client.py tests/plugins/test_subagent_coder_codex_exec_client.py
pytest tests/plugins/test_subagent_coder_codex_exec_client.py -v
```
Expected: PASS

- [ ] **Step 2.5: Commit**

```bash
git add -A
git commit -m "refactor(subagent_coder): move codex_exec_client into plugin package"
```

- [ ] **Step 2.6~2.10: Steps 2.1~2.5 반복 — coder_sessions**

각 파일 단위로 같은 cycle (mv → grep imports → fix → test PASS → commit).

- [ ] **Step 2.11~2.15: coder_progress_formatter**

- [ ] **Step 2.16~2.20: coder_event_bus**

- [ ] **Step 2.21~2.25: coder_config**

- [ ] **Step 2.26: Full regression**

```bash
pytest tests/ -x --ignore=tests/integration -q 2>&1 | tail -30
```
Expected: 모든 기존 테스트 PASS. FAIL 발생 시 그 자리에서 fix → commit.

---

## Task 3: codex-exec model provider plugin 흡수

**왜**: `plugins/model-providers/codex-exec/`를 `plugins/subagent_coder/`에 통합. 코더 plugin 하나가 코어 + provider를 같이 wire하도록.

**Files:**
- Move/merge: `plugins/model-providers/codex-exec/__init__.py` → `plugins/subagent_coder/codex_provider.py`
- Move/merge: `plugins/model-providers/codex-exec/plugin.yaml` → 내용을 subagent_coder/plugin.yaml에 흡수
- Modify: `plugins/subagent_coder/__init__.py` (register에 provider 등록 추가)
- Delete: `plugins/model-providers/codex-exec/` 디렉터리

- [ ] **Step 3.1: 기존 codex-exec plugin 내용 점검**

```bash
cat plugins/model-providers/codex-exec/__init__.py
cat plugins/model-providers/codex-exec/plugin.yaml
```
어떤 함수가 ctx에 register하는지 파악.

- [ ] **Step 3.2: Write failing test — provider registered after register(ctx)**

`tests/plugins/test_subagent_coder_provider.py`:
```python
"""subagent_coder가 register 시 codex-exec model provider를 등록해야 한다."""
from unittest.mock import MagicMock
from plugins.subagent_coder import register

def test_register_adds_codex_exec_provider():
    ctx = MagicMock()
    register(ctx)
    calls = [c for c in ctx.method_calls if "provider" in str(c).lower()]
    assert calls, "ctx에 provider 관련 호출이 없음"
    # codex-exec 이름이 어딘가에 전달되었는지 확인
    args_text = str(ctx.method_calls)
    assert "codex-exec" in args_text
```

- [ ] **Step 3.3: Run — FAIL** (register skeleton이 provider 등록 안 함)

```bash
pytest tests/plugins/test_subagent_coder_provider.py -v
```
Expected: FAIL — assertion error

- [ ] **Step 3.4: Move provider 코드**

```bash
git mv plugins/model-providers/codex-exec/__init__.py plugins/subagent_coder/codex_provider.py
```
codex_provider.py의 register 호출 부분을 함수로 추출 (예: `register_codex_provider(ctx)`).

- [ ] **Step 3.5: subagent_coder/__init__.py 업데이트**

```python
from . import codex_provider

def register(ctx) -> None:
    logger.info("subagent_coder: register(ctx) started")
    codex_provider.register_codex_provider(ctx)
    logger.info("subagent_coder: codex-exec provider registered")
```

- [ ] **Step 3.6: Run — PASS**

```bash
pytest tests/plugins/test_subagent_coder_provider.py -v
```
Expected: PASS

- [ ] **Step 3.7: 기존 plugin 디렉터리 삭제 + plugin.yaml 정리**

```bash
rm -rf plugins/model-providers/codex-exec
# (만약 plugins/model-providers/ 전체가 비면 디렉터리도 삭제)
```
plugin.yaml의 description에 "+ codex-exec model provider" 명시 (선택).

- [ ] **Step 3.8: Full plugin discovery 회귀**

```bash
pytest tests/providers/test_plugin_discovery.py -v
```
Expected: PASS. plugin 수가 1 감소 (-1) — 우리가 두 plugin을 하나로 합쳤으므로. 만약 count 검증 테스트가 있으면 그 expected 값 업데이트.

- [ ] **Step 3.9: Commit**

```bash
git add -A
git commit -m "refactor(subagent_coder): absorb codex-exec model provider plugin

Single plugin now owns both Codex core modules and the codex-exec model
provider — reduces plugin count and gives one register(ctx) site for all
coder wiring."
```

---

## Task 4: `delegate_task_background` registry 외부화 — agent loop elif 제거

**왜**: Spec Section 4 검증 1 — `registry.register` handler가 `**kw`로 `parent_agent`를 자동 전달. inline elif 두 군데와 `_dispatch_delegate_task_background` 메서드 제거 가능.

**Files:**
- Create: `plugins/subagent_coder/delegate_background.py`
- Modify: `tools/delegate_tool.py` (delegate_task_background 함수만 남기고 +434 LOC의 helper들을 plugin으로 이동)
- Modify: `run_agent.py` (`_dispatch_delegate_task_background` 메서드 + 두 elif 제거)
- Modify: `plugins/subagent_coder/__init__.py` (register에 tool 등록 추가)
- Modify: `toolsets.py` (필요 시 — Step 0.3 결과에 따라)
- Test: `tests/plugins/test_subagent_coder_delegate.py`

- [ ] **Step 4.1: Write failing test — registry handler가 parent_agent 받는지**

`tests/plugins/test_subagent_coder_delegate.py`:
```python
"""delegate_task_background가 registry handler 경로로 호출되고
parent_agent를 kw로 받아야 한다 (Spec 검증 1)."""
from unittest.mock import MagicMock
from plugins.subagent_coder import register


def test_delegate_task_background_registered_with_parent_agent_kw():
    from tools.registry import registry
    # 사전 상태 캡처
    pre = "delegate_task_background" in {e["name"] for e in registry.list_entries()}
    ctx = MagicMock()
    register(ctx)
    post = "delegate_task_background" in {e["name"] for e in registry.list_entries()}
    assert post, "register 후 delegate_task_background가 registry에 없음"

    entry = next(e for e in registry.list_entries() if e["name"] == "delegate_task_background")
    # handler가 kw['parent_agent']를 사용하는지 invoke로 검증
    parent = MagicMock(name="parent_agent")
    parent.tool_progress_callback = MagicMock()
    result = entry["handler"](
        {"goal": "test goal", "context": ""},
        parent_agent=parent,
    )
    # handler 내부에서 parent_agent.tool_progress_callback 등에 닿거나
    # 또는 coder_run_id가 돌아와야 함
    assert isinstance(result, (str, dict))
```

- [ ] **Step 4.2: Run — FAIL** (handler 미등록)

```bash
pytest tests/plugins/test_subagent_coder_delegate.py -v
```
Expected: FAIL — assert post

- [ ] **Step 4.3: delegate_background.py로 핵심 로직 추출**

`tools/delegate_tool.py`에서 다음 심볼을 추출 → `plugins/subagent_coder/delegate_background.py`:
- `delegate_task_background` 함수 본체
- `_CODER_RUN_REGISTRY` (전역 dict)
- `_spawn_codex_coder`, `_spawn_followup_coder`, `_spawn_detached_coder`
- `_build_coder_progress_sink`
- `_CODER_SINKS` dict + `register_coder_sink`/`unregister_coder_sink`/`get_coder_sink`
- `SANDBOX_RESUME_EQUIV` dict

해당 코드 블록(약 434 LOC)을 통째로 새 파일로 이동. `tools/delegate_tool.py`에는 import만 남김:
```python
# Backwards-compat re-export (legacy callers — Step 4.8에서 정리)
from plugins.subagent_coder.delegate_background import (
    delegate_task_background,
    CODER_RUN_REGISTRY,
)
```

- [ ] **Step 4.4: subagent_coder/__init__.py에 tool register 추가**

```python
from tools.registry import registry
from . import delegate_background

def register(ctx) -> None:
    ...
    codex_provider.register_codex_provider(ctx)
    registry.register(
        name="delegate_task_background",
        toolset="delegation",
        schema=delegate_background.DELEGATE_TASK_BACKGROUND_SCHEMA,
        handler=lambda args, **kw: delegate_background.delegate_task_background(
            goal=args.get("goal"),
            context=args.get("context", ""),
            parent_agent=kw.get("parent_agent"),
        ),
        check_fn=lambda: True,
        emoji="🧑‍💻",
    )
```

- [ ] **Step 4.5: Run — PASS**

```bash
pytest tests/plugins/test_subagent_coder_delegate.py -v
```
Expected: PASS

- [ ] **Step 4.6: 기존 delegate_background 테스트 회귀**

```bash
pytest tests/tools/test_delegate_background.py -v
```
Expected: 9 PASS (기존). FAIL이면 import 경로 fix.

- [ ] **Step 4.7: agent loop inline elif 제거 (run_agent.py)**

`run_agent.py`에서 다음을 삭제:
- `def _dispatch_delegate_task_background(self, function_args): ...` 메서드 (라인 ~3924 직후 우리가 추가한)
- agent loop 안의 `elif function_name == "delegate_task_background":` 두 군데 (dispatch + cute message 양쪽)

registry handler가 처리하므로 일반 tool 분기로 fall-through 되도록.

- [ ] **Step 4.8: Run — registry path로 delegate_task_background가 실호출되는지 통합 테스트**

```bash
pytest tests/tools/test_delegate_background.py tests/plugins/test_subagent_coder_delegate.py -v
```
Expected: 모두 PASS.

⚠ 만약 `parent_agent.coder_spawn_callback`가 발화 안 되는 경우(우리 `_dispatch_delegate_task_background`가 했던 일) — handler 내부에서 동일 callback 발화 코드 추가:
```python
# delegate_background.py:delegate_task_background 끝에서
if parent_agent and getattr(parent_agent, "coder_spawn_callback", None):
    try:
        parent_agent.coder_spawn_callback(coder_run_id, goal)
    except Exception as e:
        logger.debug("coder_spawn_callback failed: %s", e)
```

- [ ] **Step 4.9: Mini-smoke (사람이 손으로)**

Gateway를 재시작하고 Discord에서 한 번 자연어 위임 시도. 코더 thread가 정상 생성되는지 확인. 깨지면 Step 4.7~4.8 디버깅.

```bash
sudo systemctl restart hermes-agent  # or whatever runs the gateway
# Discord에서 "@Hermes /tmp/foo.py에 hello world 출력하는 코드 작성해줘" 메시지
```

- [ ] **Step 4.10: Full regression**

```bash
pytest tests/ -x --ignore=tests/integration -q 2>&1 | tail -20
```
Expected: 308+ PASS.

- [ ] **Step 4.11: Commit**

```bash
git add -A
git commit -m "refactor(subagent_coder): externalize delegate_task_background via registry

Spec 검증 1 — registry.register handler가 **kw로 parent_agent를 자동 전달.
inline _dispatch_delegate_task_background와 agent loop elif 두 군데 제거.
delegate_background.py가 단일 진실 원천."
```

---

## Task 5: `agent/auxiliary_client.py +28` 외부화

**왜**: `_EXTERNAL_PROCESS_DEFAULTS`에 codex-exec 분기를 박은 것을 plugin register 시 `.update(...)`로 옮긴다.

**Step 0.5 결과 의존**: defaults dict가 mutable이라고 확인된 경우만 이 Task. 아니면 위험 표 1번 대응.

**Files:**
- Modify: `agent/auxiliary_client.py` — codex-exec 관련 28 라인 제거
- Modify: `plugins/subagent_coder/__init__.py` — register에 `.update(...)` 추가
- Test: `tests/plugins/test_subagent_coder_aux.py`

- [ ] **Step 5.1: Write failing test**

```python
"""subagent_coder.register 후 codex-exec가 _EXTERNAL_PROCESS_DEFAULTS에 있어야."""
from unittest.mock import MagicMock
from plugins.subagent_coder import register
from agent.auxiliary_client import _EXTERNAL_PROCESS_DEFAULTS

def test_codex_exec_in_external_process_defaults_after_register():
    ctx = MagicMock()
    register(ctx)
    assert "codex-exec" in _EXTERNAL_PROCESS_DEFAULTS
    entry = _EXTERNAL_PROCESS_DEFAULTS["codex-exec"]
    assert "command" in entry
    assert isinstance(entry.get("args"), list)
```

- [ ] **Step 5.2: Run — FAIL** (아직 register가 update 안 함; 또는 inline에 의해 PASS면 inline 제거 후 다시 RED 확인)

- [ ] **Step 5.3: auxiliary_client.py 정리 + register에 update 추가**

`agent/auxiliary_client.py`에서 우리 추가 28 라인 (codex-exec 분기) 제거. `_EXTERNAL_PROCESS_DEFAULTS`는 upstream 상태로 복귀.

`plugins/subagent_coder/__init__.py`:
```python
def register(ctx):
    ...
    from agent.auxiliary_client import _EXTERNAL_PROCESS_DEFAULTS
    _EXTERNAL_PROCESS_DEFAULTS["codex-exec"] = {
        "command": "codex",
        "args": ["exec", "--json", "--skip-git-repo-check",
                 "--sandbox", "danger-full-access"],
    }
```

- [ ] **Step 5.4: Run — PASS**

```bash
pytest tests/plugins/test_subagent_coder_aux.py tests/providers/ -v
```
Expected: PASS

- [ ] **Step 5.5: Commit**

```bash
git add -A
git commit -m "refactor(subagent_coder): externalize codex-exec _EXTERNAL_PROCESS_DEFAULTS

agent/auxiliary_client.py 28 LOC 인라인 제거. plugin register 시점에
defaults dict에 update."
```

---

## Task 6: `hermes_cli/auth.py +84`, `providers.py +6` 외부화

**왜**: codex-exec credential resolver / provider 선언을 plugin register로 흡수.

**Files:**
- Modify: `hermes_cli/auth.py` — codex-exec 관련 84 라인 정리
- Modify: `hermes_cli/providers.py` — codex-exec 6 라인 정리
- Modify: `plugins/subagent_coder/__init__.py` — credential resolver hook 추가
- Test: `tests/hermes_cli/test_api_key_providers.py` (기존 — 우리 44 라인 추가분 plugin path로 이전)

- [ ] **Step 6.1: 기존 테스트(우리 44 라인 부분) 새 위치로 옮기기**

```bash
git mv tests/hermes_cli/test_api_key_providers.py tests/plugins/test_subagent_coder_credentials.py
```
또는 그 안의 codex-exec 관련 케이스만 추출해 새 파일로.

- [ ] **Step 6.2: Run — 새 테스트가 FAIL (plugin이 아직 hook 등록 안 함)**

```bash
pytest tests/plugins/test_subagent_coder_credentials.py -v
```
Expected: FAIL

- [ ] **Step 6.3: providers.py / auth.py inline 제거**

`hermes_cli/providers.py`의 codex-exec 6 라인 제거.
`hermes_cli/auth.py`의 codex-exec 84 라인 제거 (resolver branch, provider 선언, env var 등).

- [ ] **Step 6.4: plugin register에 credential resolver hook 추가**

Step 0.5 결과에 따라:
- **defaults가 mutable + hooks register API 있는 경우**: ctx에 resolver 등록.
- **API 부재 경우**: 우리 plugin이 `hermes_cli.auth` 모듈에 함수를 monkey-patch (마지막 수단). 이때 잔존 inline은 0이지만 monkey-patch 위험 명시.

샘플 코드:
```python
def register(ctx):
    ...
    from hermes_cli import auth as _auth
    # codex-exec credential resolver 등록
    _auth.PROVIDER_DEFAULTS["codex-exec"] = {
        "auth_mode": "chatgpt",
        "auth_file": "~/.codex/auth.json",
        ...
    }
```

- [ ] **Step 6.5: Run — PASS**

```bash
pytest tests/plugins/test_subagent_coder_credentials.py tests/hermes_cli/ -v
```
Expected: PASS. 기존 다른 테스트 회귀 없음.

- [ ] **Step 6.6: Commit**

```bash
git add -A
git commit -m "refactor(subagent_coder): externalize codex-exec credential & provider declaration

hermes_cli/auth.py 84 LOC + providers.py 6 LOC 인라인 제거.
plugin register가 credential resolver hook 등록 (또는 fallback monkey-patch)."
```

---

## Task 7: Discord adapter factory wrap + overlay install

**왜**: Spec 가장 큰 위험 표면. 이 Task가 성공하면 fork drift 비용의 80%가 해결됨.

**Step 0.4 결과 의존**: adapter post-connect hook 존재 여부에 따라 install 시점 결정.

**Files:**
- Create: `plugins/subagent_coder/discord_overlay.py` (gateway/platforms/discord.py +415 LOC 추출)
- Modify: `gateway/platforms/discord.py` — 우리 415 LOC 전부 제거 (upstream 그대로)
- Modify: `plugins/subagent_coder/__init__.py` — register에 factory wrap 추가
- Test: `tests/plugins/test_subagent_coder_discord_overlay.py`

- [ ] **Step 7.1: Write failing test — factory wrap이 install 호출하는지**

```python
"""subagent_coder.register가 platform_registry의 discord adapter_factory를
wrap하여 install_coder_overlay를 호출해야 한다."""
from unittest.mock import MagicMock, patch
from plugins.subagent_coder import register
from gateway.platform_registry import platform_registry


def test_discord_factory_wrapped_installs_overlay():
    # discord plugin이 이미 register됐다고 가정 (실제 plugin 로딩 시 보장됨)
    if platform_registry.get("discord") is None:
        # 테스트용 mock entry
        from gateway.platform_registry import PlatformEntry
        mock_adapter = MagicMock(name="DiscordAdapter")
        platform_registry.register(PlatformEntry(
            name="discord", label="Discord (mock)",
            adapter_factory=lambda cfg: mock_adapter,
            check_fn=lambda: True,
        ))

    ctx = MagicMock()
    with patch("plugins.subagent_coder.discord_overlay.install") as mock_install:
        register(ctx)
        entry = platform_registry.get("discord")
        adapter = entry.adapter_factory(MagicMock())
        mock_install.assert_called_once_with(adapter)
```

- [ ] **Step 7.2: Run — FAIL** (factory wrap 미구현)

- [ ] **Step 7.3: discord_overlay.py 추출**

`gateway/platforms/discord.py`(또는 upstream의 `plugins/platforms/discord/adapter.py`)에 박힌 우리 415 LOC를 `plugins/subagent_coder/discord_overlay.py`로 통째 이동.

핵심 entry point는 `install(adapter)`:
```python
def install(adapter) -> None:
    """Discord adapter 인스턴스에 코더 통합부 install.

    부착되는 것:
    - adapter._coder_sessions = CoderSessionManager()
    - adapter._coder_flusher = DebouncedFlusher(...)
    - 메서드: on_coder_event, create_coder_thread, _handle_code_slash,
              _handle_coder_followup, _cancel_coder_run, _publish_to_thread,
              _make_thread_name
    - _client.add_listener (on_message 가로채기)
    - _client.tree.add_command (/code)
    """
    from .coder_sessions import CoderSessionManager
    from .coder_progress_formatter import DebouncedFlusher

    adapter._coder_sessions = CoderSessionManager(...)
    adapter._coder_flusher = DebouncedFlusher(...)

    # 메서드 attach (module-level 함수를 인스턴스 메서드로 bind)
    import types
    for fn_name in ("on_coder_event", "create_coder_thread",
                    "_handle_code_slash", "_handle_coder_followup",
                    "_cancel_coder_run", "_publish_to_thread",
                    "_make_thread_name"):
        setattr(adapter, fn_name, types.MethodType(globals()[fn_name], adapter))

    # client/tree 등록 — Step 0.4 결과에 따라 시점 결정
    if adapter._client is not None:
        # 이미 connect 됐다면 즉시
        _wire_client_listeners(adapter)
    else:
        # connect 전이라면 connect() wrap
        orig_connect = adapter.connect
        async def wrapped_connect():
            result = await orig_connect()
            _wire_client_listeners(adapter)
            return result
        adapter.connect = wrapped_connect

def _wire_client_listeners(adapter):
    adapter._client.add_listener(adapter._coder_message_filter, "on_message")
    adapter._client.tree.add_command(_make_code_command(adapter))
```

- [ ] **Step 7.4: subagent_coder/__init__.py register에 factory wrap 추가**

```python
def register(ctx):
    ...
    from gateway.platform_registry import platform_registry
    from . import discord_overlay

    entry = platform_registry.get("discord")
    if entry is None:
        logger.warning(
            "subagent_coder: discord platform not registered yet — "
            "loading order may be wrong. Plugin name 'subagent_coder' "
            "should sort after 'discord'."
        )
        return
    orig_factory = entry.adapter_factory
    def wrapped(cfg):
        adapter = orig_factory(cfg)
        discord_overlay.install(adapter)
        return adapter
    entry.adapter_factory = wrapped
    logger.info("subagent_coder: discord adapter_factory wrapped")
```

- [ ] **Step 7.5: gateway/platforms/discord.py 인라인 415 LOC 제거**

해당 변경 부분을 모두 제거하고 upstream 상태로 복귀. `_coder_sessions`, `_coder_flusher`, `on_coder_event`, `create_coder_thread`, `_handle_code_slash`, `_handle_coder_followup`, `_cancel_coder_run` 인스턴스 attribute/메서드 모두 삭제.

(만약 작업 시점에 `plugins/platforms/discord/adapter.py`로 이미 이주됐다면 그 파일은 손도 안 댐.)

- [ ] **Step 7.6: Run — PASS**

```bash
pytest tests/plugins/test_subagent_coder_discord_overlay.py -v
```
Expected: PASS

- [ ] **Step 7.7: gateway 재시작 + 라이브 mini-smoke**

```bash
sudo systemctl restart hermes-agent
# Discord에서:
#   1. /code Write hello.py to /tmp/hello.py  (slash 등록 확인)
#   2. @Hermes /tmp/foo.py 만들어줘            (자연어 위임)
#   3. coder thread 안에서 "제곱도 추가" (follow-up)
#   4. coder thread에서 "!cancel" (취소)
```
4개 모두 정상 동작 확인.

- [ ] **Step 7.8: Full regression**

```bash
pytest tests/ -x --ignore=tests/integration -q 2>&1 | tail -20
```
Expected: 모두 PASS.

- [ ] **Step 7.9: Commit**

```bash
git add -A
git commit -m "refactor(subagent_coder): externalize discord overlay via factory wrap

gateway/platforms/discord.py에서 인라인 415 LOC 전부 제거.
platform_registry.get('discord').adapter_factory를 wrap하여
discord_overlay.install(adapter)로 통합부 설치.
가장 큰 머지 충돌 표면 해결."
```

---

## Task 8: AIAgent `coder_spawn_callback` slot 외부화 + run_agent.py 잔존 검증

**왜**: run_agent.py +73 LOC의 마지막 잔존(코더 spawn callback wire)를 plugin으로. Task 4에서 elif는 이미 제거. 남은 건 attribute 선언 한 줄과 callback wire.

**Files:**
- Modify: `run_agent.py` — Task 4 후 남은 코더 관련 라인 제거 (`self.coder_spawn_callback = None` 등)
- Modify: `plugins/subagent_coder/__init__.py` — `setattr(AIAgent, "coder_spawn_callback", None)` 추가

- [ ] **Step 8.1: 현재 run_agent.py에 남은 우리 라인 grep**

```bash
cd /home/bykim0119/.hermes/hermes-agent
git diff $(git merge-base origin/main feature/coder-subagent) feature/coder-subagent -- run_agent.py
```
남은 라인이 5 미만이면 그대로 두기. 그 이상이면 외부화 시도.

- [ ] **Step 8.2: setattr 기반 slot 설치 시도**

`plugins/subagent_coder/__init__.py`:
```python
def register(ctx):
    ...
    from run_agent import AIAgent
    if not hasattr(AIAgent, "coder_spawn_callback"):
        AIAgent.coder_spawn_callback = None  # class-level default
```

- [ ] **Step 8.3: run_agent.py에서 우리 추가분 제거**

`__init__`에 추가된 `self.coder_spawn_callback: Optional[...] = None` 라인 제거. 다른 잔존 라인 (provider == 'codex-exec' 가드 등)은 일단 유지 — 동작에 핵심.

⚠ `_create_openai_client`의 codex-exec 분기(약 25 라인)는 **잔존 OK**. 이건 본질적으로 client factory의 분기이고, 외부 plugin이 wrap하기 어려움. Step 0의 추가 검증 없이 그대로 둠.

- [ ] **Step 8.4: 라이브 smoke (자연어 위임 1회)**

`coder_spawn_callback`이 호출돼 thread 생성되는지 확인. 안 되면 setattr 위치/시점 조정.

- [ ] **Step 8.5: 현 시점 잔존 inline 측정**

```bash
BASE=$(git merge-base origin/main feature/coder-subagent)
git diff --stat $BASE feature/coder-subagent | grep -v "^A" | tail -15
```
Expected: 각 파일 모디파이 라인이 spec Section 5.4 목표에 근접:
- run_agent.py 0~5, auxiliary_client.py 0, auth.py 0~5, providers.py 0, delegate_tool.py 1, toolsets.py 0~3, discord.py 0

- [ ] **Step 8.6: Commit**

```bash
git add -A
git commit -m "refactor(subagent_coder): externalize AIAgent.coder_spawn_callback slot

setattr 기반 class-level default로 plugin이 wire. run_agent.py 잔존 inline
은 _create_openai_client의 codex-exec 분기(~25 LOC) 정도로 축소."
```

---

## Task 9: 라이브 smoke 4종 + V2 AGENTS.md 회귀

**왜**: 구현 완료 검증. spec 목표 4(현 기능 회귀 0).

**Files (read-only):**
- Discord 실 채널 (운영 봇)
- `~/.hermes/workspace/AGENTS.md` (V2 보존 확인)

- [ ] **Step 9.1: Gateway clean restart**

```bash
sudo systemctl restart hermes-agent
sleep 3
sudo journalctl -u hermes-agent -n 50 --no-pager | grep -E "subagent_coder|error|warn"
```
Expected: subagent_coder plugin 로딩 로그가 보이고 register(ctx) 완료. error 0.

- [ ] **Step 9.2: Smoke 1 — 자연어 위임**

Discord에서:
```
@Hermes /tmp/scenario1.py에 hello world 출력하는 한 줄 print 작성해줘
```
Expected:
- 코더 thread 자동 생성
- thread 안에 ▶️ command_execution + agent_message + ✅ 완료 라인 표시
- /tmp/scenario1.py 생성 확인 (ssh로)

- [ ] **Step 9.3: Smoke 2 — `/code` slash**

Discord에서:
```
/code Write a Python script that prints prime numbers up to 30 to /tmp/scenario2.py
```
Expected: 코더 thread + 파일 생성 + agent_message.

- [ ] **Step 9.4: Smoke 3 — Follow-up via codex exec resume**

Smoke 2의 thread 안에서:
```
@Hermes 50까지로 늘려줘
```
Expected: 같은 thread, codex가 resume context 인지 → /tmp/scenario2.py 갱신.

- [ ] **Step 9.5: Smoke 4 — `!cancel`**

새 코더 thread에서 (오래 걸리는 작업 지시 후):
```
!cancel
```
Expected: codex 프로세스 SIGTERM, thread에 취소 안내 메시지.

- [ ] **Step 9.6: V2 AGENTS.md 회귀**

분석 시나리오 한 번:
```
@Hermes hermes-agent의 AIAgent 클래스 역할 설명해줘
```
Expected: in-turn (코더 thread 생기지 않음, parent가 직접 답변).

- [ ] **Step 9.7: 결과 기록**

`tests/integration/test_coder_e2e.md`에 4 smoke + V2 회귀 결과 append. timestamps + 짧은 관찰.

- [ ] **Step 9.8: Commit**

```bash
cd /home/bykim0119/.hermes/hermes-agent
git add tests/integration/test_coder_e2e.md
git commit -m "test(coder): live smoke verification post fork isolation

4 scenarios + V2 AGENTS.md regression 모두 PASS.
플러그인 격리 후 기능 회귀 0 확인."
```

---

## Task 10: Master rebase dry-run + 머지 비용 baseline 측정

**왜**: Spec 목표 1(평상시 0)이 실제로 달성됐는지 측정. 결과로 운영 cadence 결정.

- [ ] **Step 10.1: 작업 트리 깨끗한지 확인**

```bash
cd /home/bykim0119/.hermes/hermes-agent
git status
```
Expected: clean. dirty면 stash 또는 commit.

- [ ] **Step 10.2: dry-run rebase**

```bash
git fetch origin
BRANCH=feature/coder-subagent
git checkout $BRANCH
git rebase origin/main 2>&1 | tee /tmp/rebase-dryrun.log
```
**중단되면**: 충돌 파일 목록 / hunk 위치 기록 후 `git rebase --abort`.

- [ ] **Step 10.3: 결과 측정**

```bash
echo "===== 충돌 발생 파일 ====="
grep -E "CONFLICT|Auto-merging" /tmp/rebase-dryrun.log | sort -u
echo "===== 충돌 라인 수 추정 ====="
# 각 충돌 파일에서 <<<<<<< 마커 카운트
```
Expected: 0~3 파일 정도. discord adapter(우리가 안 건드림) 충돌 0, run_agent.py 충돌 가능, auth.py 충돌 가능.

- [ ] **Step 10.4: Rebase 정리**

성공했으면 그대로 둠. 충돌 있었으면 abort 후 별도 fix 세션으로:
```bash
git rebase --abort
```

- [ ] **Step 10.5: 측정 결과를 메모리에 기록**

이 plan에 결과 섹션 append + 메모리 [[project_hermes_fork_isolation]]에 "2026-XX-XX 첫 rebase dry-run 결과" 추가.

- [ ] **Step 10.6: Commit**

```bash
# 결과는 plan 파일에 inline으로 적었으므로 autonormal repo에 commit
cd /home/bykim0119/autonormal
git add docs/superpowers/plans/2026-05-23-coder-fork-isolation.md
git commit -m "docs(plan): record post-migration rebase dry-run baseline"
```

---

## Done 기준 (Acceptance Checklist)

- [ ] 잔존 inline 합계 < 30 라인 (목표 0~11, 현실적 20 이하)
- [ ] 308+ 기존 단위 테스트 PASS
- [ ] 신규 plugin 테스트 PASS (Task 1~7에서 추가한 것들)
- [ ] 라이브 smoke 4종 모두 PASS
- [ ] V2 AGENTS.md 회귀 PASS
- [ ] `master` 대비 rebase dry-run 충돌 ≤ 3 파일 (Task 10 측정)
- [ ] 메모리 [[project_hermes_fork_isolation]] 갱신: 실측 비용 + 발견 사항
- [ ] `feature/coder-subagent` 브랜치 정리: subagent_coder 관련 commit 시리즈로 history 깨끗

## 후속 (별도 세션)

- P3 — Upstream PR (NousResearch에 plugin 의존성 선언 또는 adapter extension hook 추가)
- 코더 V3 — write_file/edit_file toolset에서 제거하는 실험 (별도 spec)
- D 리팩토링 — coder_manager API 추출 (별도 spec)
