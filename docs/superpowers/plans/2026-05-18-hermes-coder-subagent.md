# Hermes Coder Sub-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hermes 메인 에이전트가 코딩 작업을 별도 Codex CLI 자식(ACP) 프로세스로 background 위임하고, 자식의 진행 상황이 자동 생성된 Discord 스레드에 이모지 prefix로 실시간 스트림되도록 구현.

**Architecture:** 메인은 `delegate_task_background` 신규 tool로 자식 spawn 즉시 turn 종료(detached asyncio task). Codex 자식의 `subagent_progress` 이벤트는 coder_run_id → thread_id 매핑으로 Discord 스레드에만 publish. 스레드 안 follow-up은 같은 코더 세션에 이어지고 2시간 idle 후 cleanup.

**Tech Stack:** Python 3.11, hermes-agent (asyncio gateway), `discord.py`, Codex CLI (`~/.codex/auth.json` OAuth), pytest.

**Spec:** `docs/superpowers/specs/2026-05-18-hermes-coder-subagent-design.md`

**Pre-conditions:**
- Working tree: `/home/bykim0119/.hermes/hermes-agent/` (git, tracks `NousResearch/hermes-agent` origin/main, dirty allowed — see `project_migration_to_hermes_agent.md` Phase 11)
- 작업 전 `git status` 깨끗한지 확인. 기존 local patch (`discord.py`의 `DISCORD_ALLOW_DMS` hunk)는 보존.
- Codex CLI 동작 확인: `codex --version` 성공, `~/.codex/auth.json` 존재.
- Hermes 서비스: `systemctl --user status hermes-gateway-main.service` ACTIVE.
- 각 task 후 변경 적용 검증: `systemctl --user restart hermes-gateway-main.service` + `journalctl --user -u hermes-gateway-main -n 50` 정상 부팅 확인.
- **Python venv**: `~/.hermes/hermes-agent/venv/bin/pytest` (또는 `python`). 시스템 `python3 -m pytest`는 동작 안 함. 모든 pytest 명령은 `./venv/bin/pytest`로 실행.
- **Git identity** (이 repo local): `bukim0119@gmail.com` / `bykim0119` (이미 설정됨, Task 0에서).
- **Branch**: `feature/coder-subagent` (origin/main 대비 1 ahead, DISCORD_ALLOW_DMS hunk 보존됨).

---

## File Structure

| 파일 | 역할 | 작업 |
|---|---|---|
| `~/.hermes/hermes-agent/tools/delegate_tool.py` | 부모-자식 위임 로직, 신규 background variant | Modify (신규 함수 추가, registry 등록) |
| `~/.hermes/hermes-agent/agent/copilot_acp_client.py` | ACP stdio subprocess client | Modify (Codex 호환 env var 처리; 필요 시 `_resolve_args` 분기) |
| `~/.hermes/hermes-agent/agent/codex_exec_client.py` | (Fallback A1) `codex exec --json` 기반 클라이언트 | Create (스파이크 결과 ACP 미지원 시) |
| `~/.hermes/hermes-agent/gateway/platforms/discord.py` | Discord 어댑터, 스레드 생성/라우팅 hook + slash 등록 | Modify (5군데: hook, 라우터, formatter, slash, follow-up) |
| `~/.hermes/hermes-agent/gateway/coder_sessions.py` | 활성 코더 세션 ↔ thread 매핑 관리 + idle timeout | Create (신규 모듈, 단일 책임) |
| `~/.hermes/hermes-agent/gateway/coder_progress_formatter.py` | subagent_progress 이벤트 → 이모지 prefix 메시지 변환 + 디바운스 | Create (신규 모듈) |
| `~/.hermes/config.yaml` | delegation.coder 설정 블록 | Modify |
| `~/.hermes/.env` | `HERMES_COPILOT_ACP_COMMAND`, `HERMES_COPILOT_ACP_ARGS` | Modify |
| `~/.hermes/workspace/AGENTS.md` | 메인 LLM에게 자동 위임 가이드 | Modify (신규 섹션) |
| `~/.hermes/hermes-agent/tests/tools/test_delegate_background.py` | `delegate_task_background` 단위 테스트 | Create |
| `~/.hermes/hermes-agent/tests/gateway/test_coder_sessions.py` | 세션 매니저 단위 테스트 | Create |
| `~/.hermes/hermes-agent/tests/gateway/test_coder_progress_formatter.py` | formatter 단위 테스트 (CJK 케이스 포함) | Create |
| `~/.hermes/hermes-agent/tests/integration/test_coder_e2e.py` | (선택, plan 마지막) 통합 시나리오 | Create |

---

## Task 0: Pre-flight & backup

**Files:**
- Read-only verification commands

- [ ] **Step 1: 현재 상태 백업**

```bash
DATE=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/migration-backups/coder-subagent-$DATE
cp ~/.hermes/config.yaml ~/migration-backups/coder-subagent-$DATE/
cp ~/.hermes/.env ~/migration-backups/coder-subagent-$DATE/
cp ~/.hermes/workspace/AGENTS.md ~/migration-backups/coder-subagent-$DATE/
cd ~/.hermes/hermes-agent && git status > ~/migration-backups/coder-subagent-$DATE/git-status-pre.txt
echo "Backup: ~/migration-backups/coder-subagent-$DATE"
```

- [ ] **Step 2: 기존 local patch 위치 기록**

Run: `cd ~/.hermes/hermes-agent && git diff --stat`
Expected output: `gateway/platforms/discord.py` 등 변경 파일 목록. 이후 작업에서 이 파일들을 수정할 때 기존 hunk를 깨지 않도록 주의.

- [ ] **Step 3: 테스트 환경 sanity check**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/tools/test_delegate.py -x --co | tail -10`
Expected: 테스트 수집 정상, 에러 없음. 만약 import 에러면 venv 활성화 필요 — `source ~/.hermes/hermes-agent/.venv/bin/activate` (또는 hermes 설치 venv 경로 확인).

- [ ] **Step 4: Codex CLI 동작 확인**

Run: `codex --version && cat ~/.codex/auth.json | jq 'keys'`
Expected: codex 버전 출력 + auth.json 키 목록 (`tokens`, `expires_at` 같은 키).

---

## Task 1: Codex CLI 인터페이스 스파이크 (A vs A1 결정)

**Files:**
- Create: `~/.hermes/hermes-agent/tests/integration/spike_codex_acp.md` (수기 노트)
- No code changes this task — output is a decision document

- [ ] **Step 1: `codex` 서브명령 전수 조사**

Run: `codex --help 2>&1 | tee /tmp/codex-help.txt; for sub in mcp-server exec app-server exec-server review; do echo "=== $sub ==="; codex $sub --help 2>&1 | head -20; done`
Expected: 각 서브명령 옵션 확인. `exec --json` 옵션 존재 여부, `app-server`/`exec-server`의 stdio JSON 프로토콜 형식, `mcp-server`의 MCP 호환성.

- [ ] **Step 2: ACP wire-protocol 호환 확인 (경로 A)**

Run:
```bash
# hermes의 copilot_acp_client가 보내는 첫 메시지 형식을 알아내기 위해 client를 들여다본다
grep -nE "send|stdin.write|JSON-RPC|jsonrpc" ~/.hermes/hermes-agent/agent/copilot_acp_client.py | head -20
```

다음으로 codex stdio가 같은 JSON-RPC를 받는지 시험:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | timeout 5 codex app-server 2>&1 | head -20 || echo "no response or error"
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | timeout 5 codex exec-server 2>&1 | head -20 || echo "no response or error"
```

Expected: JSON 응답 있으면 ACP 호환 가능성 ↑. 빈 응답/에러면 A1 fallback 확정.

- [ ] **Step 3: A1 경로 (`codex exec --json`) 동작 확인**

Run:
```bash
cd /tmp && mkdir -p codex-spike && cd codex-spike
codex exec --json "echo hello world" 2>&1 | head -30
```

Expected: JSON 라인이 stdout으로 흘러나옴. 각 라인의 event 타입 (예: `text_delta`, `tool_call`, `tool_result`, `turn_complete`) 기록.

- [ ] **Step 4: 결정 노트 작성**

Create `~/.hermes/hermes-agent/tests/integration/spike_codex_acp.md` with:
```markdown
# Codex CLI 인터페이스 스파이크 결과 (YYYY-MM-DD)

## 경로 A (ACP wire-protocol via copilot_acp_client)
- 시도 결과: [PASS / FAIL — 한 줄 요약]
- 증거: [Step 2의 실제 출력 붙여넣기]
- 결정: [사용 / 미사용]

## 경로 A1 (codex exec --json)
- 동작: [확인됨 / 안 됨]
- Event types observed: [text_delta, tool_call, ...]
- 결정: [primary / fallback / 미사용]

## 최종 채택 경로
- [A 또는 A1]
- 채택 사유: [한 줄]

## 후속 task 영향
- Task 2의 client 어댑터를 [copilot_acp_client 재사용 / codex_exec_client 신규]로 진행
- env vars: HERMES_COPILOT_ACP_COMMAND=[?], HERMES_COPILOT_ACP_ARGS=[?]
```

- [ ] **Step 5: Commit**

```bash
cd ~/.hermes/hermes-agent
git add tests/integration/spike_codex_acp.md
git commit -m "docs: codex ACP/exec interface spike result"
```

---

## Task 2: 코더 client 어댑터 (경로 A 또는 A1)

**의존**: Task 1 결과에 따라 분기. **아래는 채택 경로별로 단계가 갈림** — 해당 경로만 수행.

### 분기 2A — ACP 경로 채택

**Files:**
- Modify: `~/.hermes/.env`
- Modify (read first): `~/.hermes/hermes-agent/agent/copilot_acp_client.py:34-50` (`_resolve_command`, `_resolve_args`)

- [ ] **Step 1: env vars 설정**

Edit `~/.hermes/.env`, 다음 두 줄 추가 (기존 줄은 건드리지 말 것):
```
HERMES_COPILOT_ACP_COMMAND=codex
HERMES_COPILOT_ACP_ARGS=<Task 1 Step 2에서 확인한 args, 예: app-server>
```

- [ ] **Step 2: gateway 재시작 후 단순 spawn 시도**

Run:
```bash
systemctl --user restart hermes-gateway-main.service
sleep 5
journalctl --user -u hermes-gateway-main -n 30 --no-pager | grep -iE "copilot|acp|codex" | head
```

Expected: 부팅 로그 정상, 명백한 에러 없음.

- [ ] **Step 3: Discord에서 manual delegate_task 호출 시험**

사용자에게 다음 메시지를 봇 채널에 보내달라고 요청:
```
@Hermes delegate_task를 써서 codex 자식으로 "현재 작업 디렉토리 출력" 작업을 위임해줘
```
Expected: 자식 spawn 로그가 `journalctl`에 보이고, 부모 채널에 작업 디렉토리 경로가 응답으로 옴.

- [ ] **Step 4: Commit**

```bash
cd ~/.hermes
git status -- .env  # 변경 확인
# .env는 git tracking에서 제외돼 있을 수 있음 — track 안 되면 backup만으로 충분
cd ~/.hermes/hermes-agent
git status  # 변경 없어야 함
echo "Task 2A: env-only change, no source commit needed"
```

→ Task 3로 진행.

### 분기 2B — A1 (`codex exec --json`) 경로 채택

**Files:**
- Create: `~/.hermes/hermes-agent/agent/codex_exec_client.py`
- Modify: `~/.hermes/hermes-agent/agent/auxiliary_client.py:156-160` (provider alias 추가)
- Test: `~/.hermes/hermes-agent/tests/agent/test_codex_exec_client.py`

- [ ] **Step 1: 실패 테스트 작성**

Create `~/.hermes/hermes-agent/tests/agent/test_codex_exec_client.py`:

```python
"""Tests for codex_exec_client — A1 fallback when Codex CLI doesn't speak ACP."""
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, patch

from agent.codex_exec_client import CodexExecClient, CodexEvent


@pytest.mark.asyncio
async def test_run_emits_text_delta_events():
    """codex exec --json output lines are parsed into CodexEvent objects."""
    fake_stdout = b'{"event":"text_delta","text":"hello"}\n{"event":"turn_complete"}\n'

    class FakeProc:
        stdout = asyncio.StreamReader()
        stderr = asyncio.StreamReader()
        returncode = 0
        async def wait(self): return 0

    proc = FakeProc()
    proc.stdout.feed_data(fake_stdout)
    proc.stdout.feed_eof()
    proc.stderr.feed_eof()

    with patch("asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
        client = CodexExecClient(command="codex")
        events = [e async for e in client.run(goal="say hi", workspace="/tmp")]

    assert any(e.event == "text_delta" and e.data["text"] == "hello" for e in events)
    assert any(e.event == "turn_complete" for e in events)


@pytest.mark.asyncio
async def test_malformed_json_lines_yield_raw_event():
    """Malformed JSON lines surface as raw events instead of crashing."""
    fake_stdout = b'not json at all\n{"event":"turn_complete"}\n'

    class FakeProc:
        stdout = asyncio.StreamReader()
        stderr = asyncio.StreamReader()
        returncode = 0
        async def wait(self): return 0

    proc = FakeProc()
    proc.stdout.feed_data(fake_stdout)
    proc.stdout.feed_eof()
    proc.stderr.feed_eof()

    with patch("asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
        client = CodexExecClient(command="codex")
        events = [e async for e in client.run(goal="x", workspace="/tmp")]

    assert any(e.event == "raw" for e in events)
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/agent/test_codex_exec_client.py -x -v`
Expected: `ModuleNotFoundError: No module named 'agent.codex_exec_client'` 또는 `ImportError`.

- [ ] **Step 3: 최소 구현**

Create `~/.hermes/hermes-agent/agent/codex_exec_client.py`:

```python
"""Codex CLI client using `codex exec --json` (A1 fallback path).

Spawns `codex exec --json <goal>` as a subprocess, parses JSON-line events
from stdout, and yields them as CodexEvent objects. Used when Codex CLI
does not speak the ACP wire-protocol directly.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
from dataclasses import dataclass
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)


@dataclass
class CodexEvent:
    event: str
    data: dict


class CodexExecClient:
    def __init__(
        self,
        command: str = "codex",
        extra_args: Optional[list[str]] = None,
    ):
        self.command = command
        self.extra_args = list(extra_args or [])

    async def run(
        self,
        *,
        goal: str,
        workspace: str,
        env: Optional[dict] = None,
    ) -> AsyncIterator[CodexEvent]:
        """Run codex exec, yielding parsed events as they arrive."""
        argv = [self.command, "exec", "--json"] + self.extra_args + [goal]
        proc_env = {**os.environ, **(env or {})}
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=workspace,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=proc_env,
        )
        assert proc.stdout is not None
        async for line in proc.stdout:
            text = line.decode("utf-8", errors="replace").rstrip("\n")
            if not text:
                continue
            try:
                obj = json.loads(text)
                ev_type = obj.get("event") or obj.get("type") or "unknown"
                yield CodexEvent(event=ev_type, data=obj)
            except json.JSONDecodeError:
                yield CodexEvent(event="raw", data={"text": text})
        await proc.wait()
        if proc.returncode != 0:
            stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
            yield CodexEvent(event="error", data={"returncode": proc.returncode, "stderr": stderr})
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/agent/test_codex_exec_client.py -x -v`
Expected: 2 passed.

- [ ] **Step 5: provider alias 등록**

Read `~/.hermes/hermes-agent/agent/auxiliary_client.py:150-170` to confirm alias dict structure. Find the dict containing `"github-copilot-acp": "copilot-acp"` and add an entry:
```python
    "codex-exec": "codex-exec",
```
And add a resolver branch near `copilot-acp` handling (line ~2630). The branch should return a wrapper that calls `CodexExecClient`. (정확한 wrapper 형태는 Task 3에서 delegate_task_background가 직접 client를 호출할 수도 있으므로, alias 등록만으로 충분할 수 있음 — 이 경우 Step 5는 skip하고 Task 3에서 직접 connect.)

- [ ] **Step 6: Commit**

```bash
cd ~/.hermes/hermes-agent
git add agent/codex_exec_client.py tests/agent/test_codex_exec_client.py
git commit -m "feat(agent): add codex exec --json client (A1 fallback)"
```

---

## Task 3: `delegate_task_background` 신규 tool

**Files:**
- Modify: `~/.hermes/hermes-agent/tools/delegate_tool.py:1870` (`def delegate_task` 다음에 background variant 추가) and `:2580` (registry 등록 추가)
- Test: `~/.hermes/hermes-agent/tests/tools/test_delegate_background.py`

- [ ] **Step 1: 실패 테스트 작성**

Create `~/.hermes/hermes-agent/tests/tools/test_delegate_background.py`:

```python
"""Tests for delegate_task_background — async/detached coder spawn."""
import asyncio
import pytest
from unittest.mock import MagicMock, patch

from tools.delegate_tool import delegate_task_background


def test_returns_immediately_with_handle():
    """Background variant returns coder_run_id without waiting for child."""
    parent = MagicMock()
    parent.model = "gpt-5.4"
    parent.provider = "openai-codex"
    parent.task_id = "parent-task-1"

    with patch("tools.delegate_tool._spawn_detached_coder") as mock_spawn:
        mock_spawn.return_value = "coder-run-abc123"
        result = delegate_task_background(
            parent_agent=parent,
            goal="add function X to foo.py",
            context="file at /tmp/foo.py",
        )

    assert isinstance(result, dict)
    assert result["coder_run_id"] == "coder-run-abc123"
    assert "status" in result
    assert result["status"] == "spawned"
    mock_spawn.assert_called_once()


def test_records_coder_run_for_thread_routing():
    """The spawned run is registered so gateway can map it to a Discord thread."""
    parent = MagicMock()
    parent.task_id = "parent-task-2"

    with patch("tools.delegate_tool._spawn_detached_coder") as mock_spawn, \
         patch("tools.delegate_tool._register_coder_run") as mock_register:
        mock_spawn.return_value = "coder-run-xyz"
        delegate_task_background(
            parent_agent=parent,
            goal="rename Y",
            context="",
        )

    mock_register.assert_called_once()
    call_kwargs = mock_register.call_args[1] if mock_register.call_args[1] else mock_register.call_args[0]
    # registration must include the coder_run_id and parent task linkage
    args_str = str(mock_register.call_args)
    assert "coder-run-xyz" in args_str
    assert "parent-task-2" in args_str
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/tools/test_delegate_background.py -x -v`
Expected: `ImportError: cannot import name 'delegate_task_background'`.

- [ ] **Step 3: 최소 구현 — function**

Edit `~/.hermes/hermes-agent/tools/delegate_tool.py`. Find `def delegate_task(` at line 1870. **After** the entire `delegate_task` function ends (find next `def` or top-level), insert:

```python
# ---------------------------------------------------------------------------
# Background variant — spawns child detached, returns immediately
# ---------------------------------------------------------------------------

_CODER_RUN_REGISTRY: Dict[str, Dict[str, Any]] = {}
_CODER_RUN_LOCK = threading.Lock()


def _register_coder_run(coder_run_id: str, parent_task_id: str, goal: str) -> None:
    with _CODER_RUN_LOCK:
        _CODER_RUN_REGISTRY[coder_run_id] = {
            "parent_task_id": parent_task_id,
            "goal": goal,
            "started_at": time.time(),
            "status": "running",
        }


def _spawn_detached_coder(
    parent_agent,
    goal: str,
    context: str,
    coder_run_id: str,
    acp_command: Optional[str] = None,
    provider: Optional[str] = None,
) -> str:
    """Spawn the coder child in a detached asyncio task.

    Returns the coder_run_id. Does NOT wait for completion. The child's
    progress events are routed via the gateway based on coder_run_id.
    """
    loop = asyncio.get_event_loop()
    loop.create_task(
        _run_coder_async(
            parent_agent=parent_agent,
            goal=goal,
            context=context,
            coder_run_id=coder_run_id,
            acp_command=acp_command or os.getenv("HERMES_COPILOT_ACP_COMMAND", "codex"),
            provider=provider or "copilot-acp",
        )
    )
    return coder_run_id


async def _run_coder_async(
    parent_agent,
    goal: str,
    context: str,
    coder_run_id: str,
    acp_command: str,
    provider: str,
) -> None:
    """Detached coroutine that runs the coder to completion.

    Catches all exceptions and records final status in the registry so the
    gateway can announce completion/failure to the Discord thread.
    """
    try:
        # Delegate single-task using existing infrastructure but with our coder_run_id
        # as the subagent_id so the gateway can route progress events to the thread.
        result = delegate_task(
            parent_agent=parent_agent,
            goal=goal,
            context=context,
            tasks=None,
            toolsets=["terminal", "file"],
            role="leaf",
            acp_command=acp_command,
            override_provider=provider,
            subagent_id_override=coder_run_id,  # NEW param — see Step 5
        )
        with _CODER_RUN_LOCK:
            if coder_run_id in _CODER_RUN_REGISTRY:
                _CODER_RUN_REGISTRY[coder_run_id]["status"] = "completed"
                _CODER_RUN_REGISTRY[coder_run_id]["result"] = result
    except Exception as exc:
        logger.exception("Coder run %s failed: %s", coder_run_id, exc)
        with _CODER_RUN_LOCK:
            if coder_run_id in _CODER_RUN_REGISTRY:
                _CODER_RUN_REGISTRY[coder_run_id]["status"] = "failed"
                _CODER_RUN_REGISTRY[coder_run_id]["error"] = str(exc)


def delegate_task_background(
    parent_agent,
    goal: str,
    context: str = "",
    acp_command: Optional[str] = None,
    provider: Optional[str] = None,
) -> Dict[str, Any]:
    """Async variant of delegate_task: spawns child detached, returns immediately.

    Returns:
        {"coder_run_id": str, "status": "spawned", "goal": str}

    The gateway is expected to create a Discord thread for this coder_run_id
    and route subagent_progress events with this id into the thread.
    """
    import uuid

    coder_run_id = f"coder-{uuid.uuid4().hex[:8]}"
    parent_task_id = getattr(parent_agent, "task_id", "unknown")
    _register_coder_run(coder_run_id, parent_task_id, goal)
    _spawn_detached_coder(
        parent_agent=parent_agent,
        goal=goal,
        context=context,
        coder_run_id=coder_run_id,
        acp_command=acp_command,
        provider=provider,
    )
    return {"coder_run_id": coder_run_id, "status": "spawned", "goal": goal}
```

- [ ] **Step 4: `delegate_task`에 `subagent_id_override` param 추가**

Find `def delegate_task(` (line 1870). Add a new keyword argument `subagent_id_override: Optional[str] = None,` in the signature. Inside the body, find where `subagent_id` is generated (search `_register_subagent` or `subagent_id =`) and replace with:

```python
subagent_id = subagent_id_override or _generate_subagent_id()  # or whatever the original generation logic was
```

Read the original code first to know the exact generation pattern — search `grep -n "subagent_id" tools/delegate_tool.py | head -20` to find the assignment site.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/tools/test_delegate_background.py -x -v`
Expected: 2 passed.

- [ ] **Step 6: registry 등록 (LLM이 tool로 호출 가능하도록)**

Find `registry.register(` at `tools/delegate_tool.py:2580`. **After** the existing `delegate_task` registration block, add:

```python
registry.register(
    name="delegate_task_background",
    function=delegate_task_background,
    description=(
        "Spawn a coder sub-agent asynchronously (background) and return immediately. "
        "Use this when the user requests CODE work that should not block the main "
        "conversation. The coder's progress will stream to a dedicated Discord thread; "
        "you don't need to wait. Return a short message to the user pointing to the "
        "thread (e.g. \"코더에게 위임 — 진행은 ▶ 스레드에서 확인\")."
    ),
    parameters={
        "type": "object",
        "properties": {
            "goal": {"type": "string", "description": "What the coder should accomplish (specific, self-contained)."},
            "context": {"type": "string", "description": "File paths, error messages, constraints."},
        },
        "required": ["goal"],
    },
)
```

- [ ] **Step 7: Regression — 기존 delegate_task 테스트가 깨지지 않는지 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/tools/test_delegate.py tests/tools/test_delegate_toolset_scope.py tests/agent/test_subagent_stop_hook.py -x`
Expected: 모두 PASS.

- [ ] **Step 8: Commit**

```bash
cd ~/.hermes/hermes-agent
git add tools/delegate_tool.py tests/tools/test_delegate_background.py
git commit -m "feat(tools): add delegate_task_background for async coder spawn"
```

---

## Task 4: 코더 세션 매니저 모듈

**Files:**
- Create: `~/.hermes/hermes-agent/gateway/coder_sessions.py`
- Test: `~/.hermes/hermes-agent/tests/gateway/test_coder_sessions.py`

- [ ] **Step 1: 실패 테스트 작성**

Create `~/.hermes/hermes-agent/tests/gateway/test_coder_sessions.py`:

```python
"""Tests for CoderSessionManager: coder_run_id ↔ thread_id mapping + idle timeout."""
import time
import pytest

from gateway.coder_sessions import CoderSessionManager


def test_bind_and_resolve_thread():
    mgr = CoderSessionManager(idle_timeout_seconds=7200)
    mgr.bind(coder_run_id="coder-1", thread_id="thread-A", parent_channel_id="ch-100")
    assert mgr.get_thread("coder-1") == "thread-A"
    assert mgr.get_coder_by_thread("thread-A") == "coder-1"


def test_reverse_lookup_returns_none_for_unknown():
    mgr = CoderSessionManager()
    assert mgr.get_thread("nope") is None
    assert mgr.get_coder_by_thread("nope-thread") is None


def test_idle_sessions_are_evicted():
    mgr = CoderSessionManager(idle_timeout_seconds=1)
    mgr.bind(coder_run_id="coder-old", thread_id="t-old", parent_channel_id="c1")
    time.sleep(1.2)
    mgr.tick()  # housekeeping
    assert mgr.get_thread("coder-old") is None


def test_touch_resets_idle_timer():
    mgr = CoderSessionManager(idle_timeout_seconds=1)
    mgr.bind(coder_run_id="coder-a", thread_id="t-a", parent_channel_id="c1")
    time.sleep(0.7)
    mgr.touch("coder-a")
    time.sleep(0.7)
    mgr.tick()
    assert mgr.get_thread("coder-a") == "t-a"  # not evicted, was touched


def test_max_concurrent_active():
    mgr = CoderSessionManager(max_concurrent=2)
    mgr.bind("c1", "t1", "ch")
    mgr.bind("c2", "t2", "ch")
    assert mgr.active_count() == 2
    with pytest.raises(ValueError, match="max_concurrent"):
        mgr.bind("c3", "t3", "ch")
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/gateway/test_coder_sessions.py -x -v`
Expected: `ModuleNotFoundError: No module named 'gateway.coder_sessions'`.

- [ ] **Step 3: 최소 구현**

Create `~/.hermes/hermes-agent/gateway/coder_sessions.py`:

```python
"""Coder session manager: coder_run_id ↔ Discord thread mapping.

Tracks active coder runs so that:
  - subagent_progress events for coder_run_id X route to thread_id Y
  - follow-up messages in thread_id Y route back to coder_run_id X
  - idle sessions are evicted after `idle_timeout_seconds`
  - concurrent active runs cap at `max_concurrent`

In-memory only (V1). Restart-survivable persistence is V2.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class _Session:
    coder_run_id: str
    thread_id: str
    parent_channel_id: str
    created_at: float = field(default_factory=time.time)
    last_activity_at: float = field(default_factory=time.time)


class CoderSessionManager:
    def __init__(self, idle_timeout_seconds: int = 7200, max_concurrent: int = 3):
        self.idle_timeout_seconds = idle_timeout_seconds
        self.max_concurrent = max_concurrent
        self._by_coder: Dict[str, _Session] = {}
        self._by_thread: Dict[str, str] = {}
        self._lock = threading.Lock()

    def bind(self, coder_run_id: str, thread_id: str, parent_channel_id: str) -> None:
        with self._lock:
            self._evict_idle_locked()
            if len(self._by_coder) >= self.max_concurrent:
                raise ValueError(
                    f"max_concurrent ({self.max_concurrent}) coder sessions active. "
                    f"Wait for one to finish or cancel an existing thread."
                )
            sess = _Session(
                coder_run_id=coder_run_id,
                thread_id=thread_id,
                parent_channel_id=parent_channel_id,
            )
            self._by_coder[coder_run_id] = sess
            self._by_thread[thread_id] = coder_run_id

    def get_thread(self, coder_run_id: str) -> Optional[str]:
        with self._lock:
            sess = self._by_coder.get(coder_run_id)
            return sess.thread_id if sess else None

    def get_coder_by_thread(self, thread_id: str) -> Optional[str]:
        with self._lock:
            return self._by_thread.get(thread_id)

    def touch(self, coder_run_id: str) -> None:
        with self._lock:
            sess = self._by_coder.get(coder_run_id)
            if sess:
                sess.last_activity_at = time.time()

    def unbind(self, coder_run_id: str) -> None:
        with self._lock:
            sess = self._by_coder.pop(coder_run_id, None)
            if sess:
                self._by_thread.pop(sess.thread_id, None)

    def tick(self) -> int:
        """Housekeeping: evict idle sessions. Returns count evicted."""
        with self._lock:
            return self._evict_idle_locked()

    def active_count(self) -> int:
        with self._lock:
            return len(self._by_coder)

    def _evict_idle_locked(self) -> int:
        now = time.time()
        evicted = []
        for cid, sess in list(self._by_coder.items()):
            if now - sess.last_activity_at > self.idle_timeout_seconds:
                evicted.append(cid)
        for cid in evicted:
            sess = self._by_coder.pop(cid, None)
            if sess:
                self._by_thread.pop(sess.thread_id, None)
        return len(evicted)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/gateway/test_coder_sessions.py -x -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/.hermes/hermes-agent
git add gateway/coder_sessions.py tests/gateway/test_coder_sessions.py
git commit -m "feat(gateway): add CoderSessionManager (coder ↔ thread mapping + idle timeout)"
```

---

## Task 5: 진행 이벤트 포매터 (이모지 prefix + 디바운스)

**Files:**
- Create: `~/.hermes/hermes-agent/gateway/coder_progress_formatter.py`
- Test: `~/.hermes/hermes-agent/tests/gateway/test_coder_progress_formatter.py`

- [ ] **Step 1: 실패 테스트 작성**

Create `~/.hermes/hermes-agent/tests/gateway/test_coder_progress_formatter.py`:

```python
"""Tests for CoderProgressFormatter — subagent_progress events → emoji-prefixed strings.

Includes CJK (Korean) chunk regression cases per
project_acp_codex_orchestrator memo (OpenClaw bug #2).
"""
import pytest
from gateway.coder_progress_formatter import format_event, MAX_CHUNK_CHARS


def test_read_file_event():
    out = format_event({"event": "tool_call", "tool": "read_file", "path": "src/foo.py"})
    assert out == "🔧 reading src/foo.py"


def test_edit_file_event_with_diff_stats():
    out = format_event({
        "event": "tool_call", "tool": "edit_file",
        "path": "src/foo.py", "added": 12, "removed": 3,
    })
    assert out == "✏️ editing src/foo.py (+12 -3)"


def test_terminal_command_event():
    out = format_event({"event": "tool_call", "tool": "terminal", "command": "pytest tests/"})
    assert out == "▶️ $ pytest tests/"


def test_success_completion():
    out = format_event({"event": "turn_complete", "summary": "함수 X 추가, 테스트 5개 통과"})
    assert out == "✅ 완료 — 함수 X 추가, 테스트 5개 통과"


def test_error_event():
    out = format_event({"event": "error", "message": "pytest failed: assert 1 == 2"})
    assert "❌" in out and "pytest failed" in out


def test_korean_text_preserves_spacing():
    """CJK text must not lose spacing (regression for OpenClaw chunk-trim bug #2)."""
    out = format_event({"event": "text_delta", "text": "현재 작업 디렉토리에서 파일을 읽는 중"})
    assert "현재 작업 디렉토리에서" in out  # spaces preserved between words
    assert "현재작업디렉토리" not in out


def test_long_chunks_are_capped():
    big = "x" * (MAX_CHUNK_CHARS + 500)
    out = format_event({"event": "text_delta", "text": big})
    assert len(out) <= MAX_CHUNK_CHARS + len("…[truncated]") + 10
    assert "[truncated]" in out


def test_unknown_event_returns_none():
    """Events we don't render skip silently (do not garbage-spam the thread)."""
    assert format_event({"event": "internal_metric", "value": 42}) is None
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/gateway/test_coder_progress_formatter.py -x -v`
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: 최소 구현**

Create `~/.hermes/hermes-agent/gateway/coder_progress_formatter.py`:

```python
"""Format coder subagent progress events into emoji-prefixed Discord messages."""
from __future__ import annotations

from typing import Optional

MAX_CHUNK_CHARS = 3500


def format_event(event: dict) -> Optional[str]:
    """Convert a subagent_progress event dict into a thread message string.

    Returns None for events that should not be rendered.
    Caller is responsible for debounce / batching.
    """
    et = event.get("event")
    if et == "tool_call":
        tool = event.get("tool", "")
        if tool == "read_file":
            return f"🔧 reading {event.get('path', '?')}"
        if tool == "edit_file":
            path = event.get("path", "?")
            added = event.get("added")
            removed = event.get("removed")
            if added is not None or removed is not None:
                return f"✏️ editing {path} (+{added or 0} -{removed or 0})"
            return f"✏️ editing {path}"
        if tool == "terminal":
            cmd = event.get("command", "")
            return f"▶️ $ {cmd}"
        return f"🔧 {tool}"
    if et == "text_delta":
        text = event.get("text", "")
        return _cap(text)
    if et == "turn_complete":
        summary = event.get("summary", "")
        return f"✅ 완료 — {summary}" if summary else "✅ 완료"
    if et == "error":
        msg = event.get("message", "(unknown error)")
        return f"❌ {_cap(msg)}"
    if et == "warning":
        return f"⚠️ {_cap(event.get('message', ''))}"
    if et == "plan":
        return f"📌 plan: {_cap(event.get('text', ''))}"
    return None


def _cap(text: str) -> str:
    if len(text) <= MAX_CHUNK_CHARS:
        return text
    return text[:MAX_CHUNK_CHARS] + "…[truncated]"
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ~/.hermes/hermes-agent && ./venv/bin/pytest tests/gateway/test_coder_progress_formatter.py -x -v`
Expected: 8 passed.

- [ ] **Step 5: 디바운스 helper 추가**

같은 파일 `coder_progress_formatter.py` 끝에 추가:

```python
import asyncio
import time
from collections import defaultdict
from typing import Callable, Awaitable


class DebouncedFlusher:
    """Collect short messages per thread and flush every `interval_ms`.

    Caller schedules events via add(thread_id, text). A single background
    asyncio task flushes accumulated buffers by invoking the publish coroutine.
    """

    def __init__(self, interval_ms: int = 250, publish: Optional[Callable[[str, str], Awaitable[None]]] = None):
        self.interval = interval_ms / 1000.0
        self.publish = publish
        self._buffers: dict[str, list[str]] = defaultdict(list)
        self._last_flush: dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None

    def start(self):
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def add(self, thread_id: str, text: str) -> None:
        async with self._lock:
            self._buffers[thread_id].append(text)

    async def _loop(self):
        while True:
            await asyncio.sleep(self.interval)
            async with self._lock:
                snapshots = {tid: "\n".join(parts) for tid, parts in self._buffers.items() if parts}
                self._buffers.clear()
            for tid, body in snapshots.items():
                if self.publish:
                    try:
                        await self.publish(tid, body)
                    except Exception:
                        pass  # never let one bad publish kill the loop
```

- [ ] **Step 6: Commit**

```bash
cd ~/.hermes/hermes-agent
git add gateway/coder_progress_formatter.py tests/gateway/test_coder_progress_formatter.py
git commit -m "feat(gateway): add coder progress formatter (emoji prefix + debounced flusher)"
```

---

## Task 6: Discord 어댑터 — 스레드 생성 hook + 라우터 와이어링

**Files:**
- Modify: `~/.hermes/hermes-agent/gateway/platforms/discord.py`
  - Import 추가 (file top)
  - `__init__` 또는 `start()` 메서드에 SessionManager/Flusher 인스턴스 추가
  - 메시지 핸들러에서 `delegate_task_background` tool 결과를 받아 스레드 생성
  - subagent_progress 콜백 확장 → formatter + flusher

**경고**: 이 파일은 5005줄. 변경은 4군데에 분산. 각 step은 grep 앵커로 위치 찾기.

- [ ] **Step 1: Import 추가**

Find file top imports area (`grep -n "^import\|^from" ~/.hermes/hermes-agent/gateway/platforms/discord.py | head -20`). Add after the last existing import:

```python
from gateway.coder_sessions import CoderSessionManager
from gateway.coder_progress_formatter import format_event as _format_coder_event, DebouncedFlusher
```

- [ ] **Step 2: SessionManager 인스턴스 추가**

Find the Discord platform class `__init__` (grep for `class.*Discord.*:` and then `def __init__` within it). After existing instance attributes (e.g. after `self._threads = ThreadParticipationTracker(...)`), add:

```python
        # Coder sub-agent infrastructure
        idle_to = int(os.getenv("HERMES_CODER_IDLE_TIMEOUT_S", "7200"))
        max_co = int(os.getenv("HERMES_CODER_MAX_CONCURRENT", "3"))
        self._coder_sessions = CoderSessionManager(idle_timeout_seconds=idle_to, max_concurrent=max_co)
        self._coder_flusher: Optional[DebouncedFlusher] = None  # initialized on connect
```

- [ ] **Step 3: 연결 시 flusher 시작**

Find the `on_ready` or `setup_hook` async method (`grep -n "async def on_ready\|async def setup_hook" discord.py`). At the end of that method, add:

```python
        # Start coder progress debouncer
        self._coder_flusher = DebouncedFlusher(
            interval_ms=int(os.getenv("HERMES_CODER_DEBOUNCE_MS", "250")),
            publish=self._publish_to_thread,
        )
        self._coder_flusher.start()
```

- [ ] **Step 4: `_publish_to_thread` helper 추가**

Within the same Discord class, add a method:

```python
    async def _publish_to_thread(self, thread_id: str, body: str) -> None:
        """Publish a (possibly multi-line) message to a Discord thread by id."""
        try:
            await self.send_message(
                chat_id="",  # ignored when thread_id is in metadata
                text=body,
                metadata={"thread_id": thread_id},
            )
        except Exception as exc:
            logger.warning("[%s] Failed to publish to coder thread %s: %s", self.name, thread_id, exc)
```

(send_message signature는 `discord.py:1357` 참고. metadata.thread_id 라우팅 이미 지원됨 — 새 코드 불필요.)

- [ ] **Step 5: delegate_task_background tool 결과 hook**

Find the message handler where assistant text/tool_result is announced to the channel (grep for `subagent_progress\|tool_result\|delegate_task`). Find the place where tool_result is processed for the assistant turn. When tool name is `delegate_task_background` and result is `{"coder_run_id": ..., ...}`, intercept:

```python
                if tool_name == "delegate_task_background":
                    result_obj = tool_result if isinstance(tool_result, dict) else {}
                    coder_run_id = result_obj.get("coder_run_id")
                    goal = result_obj.get("goal", "(no goal)")
                    if coder_run_id:
                        # Create a new Discord thread off the parent message
                        thread_name = self._make_thread_name(goal)
                        try:
                            parent_msg = await channel.send(
                                f"▶ 코더에게 위임 — `{coder_run_id}`"
                            )
                            thread = await parent_msg.create_thread(
                                name=thread_name,
                                auto_archive_duration=1440,
                            )
                            self._coder_sessions.bind(
                                coder_run_id=coder_run_id,
                                thread_id=str(thread.id),
                                parent_channel_id=str(channel.id),
                            )
                            # Register thread so follow-ups in it don't need @mention
                            self._threads.mark_participated(str(thread.id))
                        except ValueError as exc:
                            # max_concurrent guard
                            await channel.send(f"⚠️ {exc}")
                        except Exception as exc:
                            logger.exception("Failed to create coder thread: %s", exc)
                            await channel.send(f"❌ 코더 스레드 생성 실패: {exc}")
```

`_make_thread_name` helper도 같은 클래스에 추가:

```python
    def _make_thread_name(self, goal: str) -> str:
        # Sanitize and cap at 60 chars (Discord thread name limit is 100)
        name = " ".join(goal.split())
        name = name.replace("`", "").replace("\n", " ").strip()
        return name[:60] if len(name) > 60 else name
```

**위치 찾기 정확화**: 메시지 핸들러 정확한 라인을 모르면 `grep -nE "on_message|process_assistant_response|tool_result" discord.py | head -20`로 후보를 찾고, 가장 가까운 메시지 dispatch path를 선택. 의심되면 hook을 새 함수로 추출해 호출만 wiring.

- [ ] **Step 6: subagent_progress 콜백 확장**

Find the existing subagent_progress handling (현재 무시되거나 단순 로깅됨, `grep -n "subagent_progress" discord.py`). 콜백 함수 안에 라우팅 분기 추가:

```python
                # Route coder subagent progress events into their dedicated thread
                if event_type == "subagent_progress" and self._coder_flusher:
                    sub_id = event.get("subagent_id") or event.get("run_id")
                    if sub_id:
                        thread_id = self._coder_sessions.get_thread(sub_id)
                        if thread_id:
                            msg = _format_coder_event(event)
                            if msg:
                                self._coder_sessions.touch(sub_id)
                                await self._coder_flusher.add(thread_id, msg)
                            return  # absorbed; don't publish to main channel
```

- [ ] **Step 7: 부팅 확인**

Run:
```bash
systemctl --user restart hermes-gateway-main.service
sleep 5
journalctl --user -u hermes-gateway-main -n 50 --no-pager | tail -30
```
Expected: `[Discord] Connected as Hermes#4832` 정상. 새 import/init 관련 에러 없음.

- [ ] **Step 8: 라이브 smoke test (Discord)**

사용자에게 봇 채널에서 다음 메시지 요청:
```
@Hermes delegate_task_background로 "echo hello world 명령 실행"을 위임해줘
```
Expected:
- 채널에 "▶ 코더에게 위임 — `coder-xxxxxxxx`" 메시지 + 새 스레드 자동 생성
- 스레드에 `▶️ $ echo hello world` 같은 진행 이모지 + `✅ 완료 — ...` 마무리

만약 스레드는 생기지만 진행 이벤트가 안 보이면 Task 1의 스파이크 결과를 다시 확인 — Codex 자식이 subagent_progress 이벤트를 실제로 발화하는지 (Codex stdout 직접 캡처가 필요할 수도, Task 7에서 보완).

- [ ] **Step 9: Commit**

```bash
cd ~/.hermes/hermes-agent
git add gateway/platforms/discord.py
git commit -m "feat(discord): thread creation + coder progress routing"
```

---

## Task 7: subagent_progress 이벤트 발화 보강 (필요 시)

**의존**: Task 6 Step 8 결과. **진행 이벤트가 충분히 발화되면 이 task skip.**

**Files:**
- Modify: `~/.hermes/hermes-agent/tools/delegate_tool.py` (또는 `agent/copilot_acp_client.py` / `agent/codex_exec_client.py` — Task 1 결정 경로에 따라)

- [ ] **Step 1: 현재 발화 이벤트 grep**

Run: `grep -n "subagent_progress\|emit.*progress\|progress_callback" ~/.hermes/hermes-agent/tools/delegate_tool.py | head -20`
원본 발화 site를 찾아 어떤 키들이 들어있는지 확인.

- [ ] **Step 2: Codex 자식 stdout 라인 → subagent_progress 변환**

If using A1 path: in `_run_coder_async` (Task 3에서 만든 함수), 자식 client의 yield 이벤트마다 메인 progress callback을 호출하도록 한 단계 추가:

```python
async for ev in client.run(goal=goal, workspace=...):
    progress_event = {
        "event": "subagent_progress",
        "subagent_id": coder_run_id,
        "run_id": coder_run_id,
        "event": ev.event,  # tool_call, text_delta, turn_complete...
        **ev.data,
    }
    parent_agent.emit_event(progress_event)  # or whatever the actual emit method is
```

If using A path: `copilot_acp_client.py`가 이미 발화하는지 grep 후, 추가 발화 site가 필요한지 판단.

- [ ] **Step 3: 라이브 재검증**

Task 6 Step 8 시나리오 재실행. 진행 이벤트가 스레드에 흐르는지 확인.

- [ ] **Step 4: Commit**

```bash
cd ~/.hermes/hermes-agent
git add tools/delegate_tool.py agent/  # 변경된 파일 명시
git commit -m "feat: bridge coder client events to subagent_progress emitter"
```

---

## Task 8 (REVISED 2026-05-20): `/code` slash command — Task 10 패턴 미러

**원본 plan은 `_get_active_agent_for_user` 가정 위에 직접 `delegate_task_background` 호출이었음.** helper 부재 + parent_agent 의존 sink 문제로 막힘 → Task 10 단일화 sink 완성 후 같은 패턴으로 구현.

**B-단일화 후 `/code`의 진짜 모습**: follow-up과 동일한 path를 첫 spawn에도 적용하면 됨 — 차이는 "thread를 새로 만들고 새 codex session 시작" 뿐. parent_agent 의존 X.

**Files:**
- Modify: `~/.hermes/hermes-agent/gateway/platforms/discord.py:2880` (`_register_slash_commands`)

- [ ] **Step 1: slash 등록 추가**

Find `def _register_slash_commands(self) -> None:` at line 2880. After the last `@tree.command(...)` block (e.g. after `reload-mcp`), add:

```python
        @tree.command(name="code", description="Spawn a coder sub-agent for this task")
        async def slash_code(interaction, task: str):
            # Authorization gate — matches other slash commands' pattern
            if not self._check_slash_authorization(interaction):
                await interaction.response.send_message("Not authorized.", ephemeral=True)
                return
            # Defer (coder spawn is fast but Discord wants ack within 3s)
            await interaction.response.defer(thinking=False)

            # Call delegate_task_background directly via the agent tool registry
            from tools.delegate_tool import delegate_task_background
            parent_agent = self._get_active_agent_for_user(interaction.user.id)
            if parent_agent is None:
                await interaction.followup.send("No active Hermes session.")
                return
            result = delegate_task_background(
                parent_agent=parent_agent,
                goal=task,
                context="",
            )
            coder_run_id = result["coder_run_id"]
            thread_name = self._make_thread_name(task)
            parent_msg = await interaction.followup.send(
                f"▶ 코더에게 위임 — `{coder_run_id}`",
                wait=True,
            )
            try:
                thread = await parent_msg.create_thread(
                    name=thread_name,
                    auto_archive_duration=1440,
                )
                self._coder_sessions.bind(
                    coder_run_id=coder_run_id,
                    thread_id=str(thread.id),
                    parent_channel_id=str(interaction.channel.id),
                )
                self._threads.mark_participated(str(thread.id))
            except ValueError as exc:
                await interaction.followup.send(f"⚠️ {exc}")
            except Exception as exc:
                await interaction.followup.send(f"❌ 스레드 생성 실패: {exc}")
```

**`_get_active_agent_for_user` 정확한 helper 이름**: grep `grep -nE "_get_active_agent|get_agent_for|session_for_user" discord.py | head` 로 찾아 정확한 이름 사용. 없으면 sessions 구조를 보고 어떻게 active agent에 접근하는지 결정.

- [ ] **Step 2: slash sync 트리거**

Run: `systemctl --user restart hermes-gateway-main.service && sleep 30`
Expected: 자동 reconcile (~10-20초 후) 로그에 `created=1` 또는 `Synced N slash commands` 확인.

```bash
journalctl --user -u hermes-gateway-main -n 100 --no-pager | grep -iE "slash|reconcile|synced"
```

- [ ] **Step 3: 라이브 검증**

사용자: Discord 데스크탑에서 Ctrl+R (캐시 무효화 — `project_quickset_plugin.md` 알려진 운영 이슈), 봇 채널에서 `/code echo hello` 시도.
Expected: 스레드 생성 + 진행 표시.

- [ ] **Step 4: Commit**

```bash
cd ~/.hermes/hermes-agent
git add gateway/platforms/discord.py
git commit -m "feat(discord): add /code slash command"
```

---

## Task 9: 자동 위임 가이드 (AGENTS.md)

**Files:**
- Modify: `~/.hermes/workspace/AGENTS.md`

- [ ] **Step 1: 가이드 섹션 추가**

Edit `~/.hermes/workspace/AGENTS.md`. 적절한 위치 (예: 기존 "도구 사용 가이드" 섹션 다음)에 추가:

```markdown
## 🧑‍💻 Coding Delegation

코드 작성/수정/실행/디버깅 요청은 메인 대화 컨텍스트를 채우지 않도록 별도 코더 자식에게 위임한다.

### 위임 트리거 (자동)
다음 종류의 요청은 `delegate_task_background`로 즉시 위임:
- "X 함수/파일/모듈 만들어/추가해/수정해"
- "이 코드 디버깅해줘 / 에러 고쳐줘"
- "테스트 작성/실행해줘"
- "리팩토링해줘 / 정리해줘"
- 명령 실행이 여러 단계 필요한 요청

### 위임 안 함 (메인이 직접 답)
- 짧은 코드 설명/리뷰 (한 함수 5줄 이내, 변경 없음)
- 개념/디자인 토론
- 한 줄 syntax 질문

### 헷갈리면
메인이 직접 답하는 쪽으로 bias. 답한 뒤 "`/code`로 강제로 코더에게 넘길까?" 한 줄 묻기.

### 호출 패턴
```
delegate_task_background(
    goal="자기완결적 한 줄 요약 — 자식은 대화 history를 모름",
    context="관련 파일 경로, 에러 메시지, 제약 (간결하게)"
)
```

호출 직후 사용자에게 보낼 응답 예: "코더에게 위임 — 진행은 ▶ 스레드 참조"
(스레드는 자동 생성되므로 메인이 thread URL을 알 필요 없음.)

### 위임 후 메인의 역할
- 스레드는 코더 전용 — 메인은 본 채널에서 다른 대화 계속 가능
- 사용자가 본 채널에서 "코더 어디까지 갔어?" 물으면 active_subagents API 또는 단순히 "스레드 참조" 응답
- 코더가 끝나면 (✅ 완료 메시지) 메인은 별도 ping 안 함 (스레드 알림으로 충분)
```

- [ ] **Step 2: 적용 확인**

Run: `systemctl --user restart hermes-gateway-main.service`
사용자: 봇 채널에서 코딩 요청 (예: "@Hermes /tmp/test.py에 hello world 함수 추가해줘").
Expected: 메인이 자동으로 `delegate_task_background` 호출 → 스레드 생성.

만약 무시하면 (메인이 직접 답하려고 시도) — V1은 받아들임 (`/code` fallback 존재). V2에서 키워드 라우터 검토.

- [ ] **Step 3: Commit (workspace는 별도 git이 아닐 수 있음 — 백업만)**

```bash
cp ~/.hermes/workspace/AGENTS.md ~/migration-backups/coder-subagent-$DATE/AGENTS.md.post-task9
```

---

## Task 10 (REVISED 2026-05-20): 스레드 follow-up — `codex exec resume` 기반 + sink 단일화

**원본 Task 10 plan은 outdated 가정 위에 작성됐음.** 정정 사항:

- ❌ **잘못된 가정**: "`codex exec`는 한 번 끝나면 resume 안 됨" → V1으로 "follow-up마다 새 spawn + thread 메시지 prompt prefix"
- ✅ **실제**: Codex 0.121.0에 `codex exec resume <SESSION_ID> [PROMPT]` 서브커맨드 존재. session 컨텍스트 그대로 이어쓰기 가능.
- ❌ **잘못된 가정**: `_get_active_agent_for_user(user_id)` helper 존재 → 실재 없음
- ✅ **실제**: 현재 sink는 `parent_agent.tool_progress_callback` 의존, parent_agent는 normal turn 안에서만 wire되는 turn-local 클로저. follow-up은 turn 밖이라 이 sink 못 씀.

**채택 경로**: B-단일화 = resume 기반 follow-up + sink를 gateway-level로 단일화.

**핵심 아키텍처**:
- sink → 직접 gateway 이벤트 버스 → adapter.on_coder_event (parent_agent 미경유)
- 첫 spawn / follow-up 모두 같은 sink 패턴 사용
- 자연어 위임 path는 그대로 (parent_agent는 여전히 delegate_task가 child agent 만들 때 필요 — sink 결정에만 무관)

**Files:**
- Modify: `gateway/coder_sessions.py` (UUID 필드)
- New: `gateway/coder_event_bus.py` (sink 디스패치)
- Modify: `tools/delegate_tool.py` (sink 단일화 + thread.started 캡쳐)
- Modify: `gateway/run.py` (코더용 subagent_progress 분기 제거)
- Modify: `gateway/platforms/discord.py` (bus 등록 + on_message 분기 + follow-up spawn)

- [ ] **Step 1: CoderSessionManager 확장 — codex_session_id 보관**

`_Session` 데이터클래스에 `codex_session_id: Optional[str] = None` 필드 추가. `set_codex_session_id(coder_run_id, session_id)` / `get_codex_session_id(coder_run_id) -> Optional[str]` 두 API 추가. 락 잡고 작업. 단위 테스트: set/get 왕복, 없는 coder_run_id에 set은 no-op, get은 None.

- [ ] **Step 2: gateway coder event bus 신규**

새 파일 `gateway/coder_event_bus.py` (~30줄):
- 모듈 변수 `_HANDLERS: list[tuple[Callable, asyncio.AbstractEventLoop]] = []` + lock
- `register_handler(handler: Callable[[str, dict], Awaitable[None]], loop)` / `unregister_handler(handler)`
- `dispatch(coder_run_id: str, payload: dict)`: 등록된 모든 handler에 `asyncio.run_coroutine_threadsafe(handler(coder_run_id, payload), loop)`로 fan-out
- 사용 패턴: 어댑터(Discord)가 init 시 `register_handler(self.on_coder_event, self._loop)`. shutdown 시 unregister.

단위 테스트: handler 등록 → dispatch → handler 호출 검증. 미등록 시 silent no-op.

- [ ] **Step 3: delegate_tool sink 단일화 + thread.started UUID 캡쳐**

`tools/delegate_tool.py:_build_coder_progress_sink(parent_agent, coder_run_id)` 시그니처를 `_build_coder_progress_sink(coder_run_id)`로 변경 (parent_agent 제거). 내부 구현:

```python
def _build_coder_progress_sink(coder_run_id: str):
    from gateway import coder_event_bus
    from gateway.coder_sessions import get_global_sessions  # or pass-in
    def _sink(event):
        try:
            # Capture codex session UUID on thread.started for resume.
            if event.event == "thread.started":
                tid = (event.data or {}).get("thread_id")
                if tid:
                    sessions = get_global_sessions()
                    if sessions is not None:
                        sessions.set_codex_session_id(coder_run_id, tid)
            payload = {"event": event.event, "data": event.data}
            coder_event_bus.dispatch(coder_run_id, payload)
        except Exception:
            logger.debug("coder sink relay failed", exc_info=True)
    return _sink
```

`get_global_sessions()`는 DiscordAdapter init에서 본인 `_coder_sessions`를 모듈 변수로 set하는 방식 (`gateway/coder_sessions.py`에 set/get_global). `_spawn_detached_coder` 호출 시 parent_agent 인자 제거.

- [ ] **Step 4: gateway/run.py 코더용 subagent_progress 분기 제거**

`gateway/run.py:13460` 부근의 `if event_type == "subagent_progress":` 분기에서 `kwargs.get("event")`/`subagent_id` 갖춘 코더 케이스는 dead code (이제 bus가 직접 받음). 그 분기만 제거. legacy nested orchestrator path (summary string 형태)는 그대로.

- [ ] **Step 5: Discord adapter — bus 등록 + on_message thread 분기**

`DiscordAdapter.__init__`에서 코더 세션 인스턴스 set_global + on_ready/setup에서 `coder_event_bus.register_handler(self.on_coder_event, self._loop)`. shutdown에서 unregister.

`on_message` (line 711)의 dedup/auth 게이트 통과 직후, **bot 메시지/시스템 메시지 필터 다음** 위치에 thread 분기 추가:

```python
if isinstance(message.channel, discord.Thread):
    cid = self._coder_sessions.get_coder_by_thread(str(message.channel.id))
    if cid:
        self._coder_sessions.touch(cid)
        # Skip Hermes routing entirely; route to coder
        await self._handle_coder_followup(cid, message.content, message.channel)
        return
```

- [ ] **Step 6: `_handle_coder_followup` + follow-up spawn**

`DiscordAdapter._handle_coder_followup(coder_run_id, text, thread)`:
1. `codex_session_id = self._coder_sessions.get_codex_session_id(coder_run_id)`
2. 없으면: `await thread.send("⚠️ 코더 세션 UUID 없음 — resume 불가")` + return
3. 데몬 스레드 시작 → `_spawn_followup_coder(coder_run_id, text, codex_session_id)` 호출

`tools/delegate_tool.py` (또는 `agent/codex_exec_client.py`)에 `_spawn_followup_coder` 추가:
- sink = `_build_coder_progress_sink(coder_run_id)` (Step 3과 동일)
- register_coder_sink(coder_run_id, sink)
- daemon Thread로 `_followup_runner`:
  - `CodexExecClient` 직접 사용 (CodexExecFacade는 AIAgent용이라 안 씀)
  - argv: `["codex", "exec", "resume", session_id, "--json", "--skip-git-repo-check", *sandbox_args, text]`
  - `async for event in client.run(...)` → sink 호출
  - finally: unregister_coder_sink

sandbox/extra_args는 `HERMES_CODER_ARGS`의 spawn-time 값을 일관되게 가져옴 (Step 3 sink가 어차피 같은 sessions에 thread.started로 UUID 저장한 상태).

- [ ] **Step 7: 통합 단위 테스트**

- coder_sessions: codex_session_id set/get 왕복 (Step 1)
- bus: register → dispatch → handler 호출 (Step 2)
- sink: thread.started 들어오면 sessions.set_codex_session_id 호출 (Step 3)
- follow-up runner argv: resume 서브커맨드 + UUID + extra_args 조립 검증 (Step 6)

기존 회귀: `tests/agent/test_codex_exec_client.py`의 register_coder_sink 7줄은 API 시그니처 변경 없으므로 그대로 pass. `tests/tools/test_delegate.py`의 legacy subagent_progress 테스트는 코더 path와 무관, 영향 없음.

- [ ] **Step 8: 라이브 smoke**

```bash
systemctl --user restart hermes-gateway-main.service
```

1. 채널에서 코딩 요청 → 스레드 생성 + 진행 이벤트 정상.
2. 그 스레드 안에서 follow-up 메시지 ("그리고 README도 업데이트해줘") → 새 진행 이벤트 같은 스레드에 흐름. `codex exec resume` 호출돼서 이전 컨텍스트 유지되는지 확인.
3. follow-up 후 같은 thread에 다시 → resume이 누적되는지 확인.

- [ ] **Step 9: Commits**

논리 단위로 분할:
- `feat(coder-sessions): track codex session uuid` (Step 1)
- `feat(gateway): coder event bus` (Step 2)
- `refactor(coder): unify sink via event bus` (Step 3+4)
- `feat(discord): coder thread follow-up via codex exec resume` (Step 5+6)
- 모두 한 번에 묶는 게 자연스러우면 통합 커밋도 OK.

---

## Task 11: 취소 처리 (`stop`/`cancel`)

**Files:**
- Modify: `~/.hermes/hermes-agent/gateway/platforms/discord.py`
- Reuse: `tools.delegate_tool.interrupt_subagent` (Task 1 grep에서 발견됨: `delegate_tool.py:183`)

- [ ] **Step 1: `_cancel_coder_run` 구현**

Discord 클래스에 추가:

```python
    async def _cancel_coder_run(self, coder_run_id: str, thread) -> None:
        """Interrupt a running coder and announce cancellation in its thread."""
        from tools.delegate_tool import interrupt_subagent
        ok = interrupt_subagent(coder_run_id)
        if ok:
            await thread.send("❌ 취소됨")
        else:
            await thread.send(f"⚠️ 취소 시도 — 해당 코더(`{coder_run_id}`)가 이미 종료/미등록")
        self._coder_sessions.unbind(coder_run_id)
```

- [ ] **Step 2: 라이브 검증**

사용자: 활성 코더 스레드에서 `cancel` 입력.
Expected: 스레드에 `❌ 취소됨`. 진행 이벤트 중단.

- [ ] **Step 3: Commit**

```bash
cd ~/.hermes/hermes-agent
git add gateway/platforms/discord.py
git commit -m "feat(discord): coder cancellation via stop/cancel keyword"
```

---

## Task 12: config 통합 + OAuth expiry handling

**Files:**
- Modify: `~/.hermes/config.yaml`
- Modify: `~/.hermes/hermes-agent/tools/delegate_tool.py` (env vars → config 우선)

- [ ] **Step 1: config 블록 추가**

Edit `~/.hermes/config.yaml`. Find existing `delegation:` block (line ~136). Replace it (보존+확장):

```yaml
delegation:
  max_iterations: 50
  coder:
    provider: copilot-acp
    acp_command: codex
    model: gpt-5.3-codex
    fallback_mode: exec_json
    max_concurrent: 3
    idle_timeout_seconds: 7200
    auto_deny_dangerous: true
    progress_debounce_ms: 250
    max_chunk_chars: 3500
```

- [ ] **Step 2: env var fallback 우선순위 명시**

`tools/delegate_tool.py`에서 coder 관련 값 읽는 site (예: max_concurrent, idle_timeout)에 다음 패턴:
```python
# Priority: env var > config > default
val = os.getenv("HERMES_CODER_IDLE_TIMEOUT_S") or config.get("delegation.coder.idle_timeout_seconds", 7200)
```

Discord.py의 SessionManager 초기화 부분(Task 6 Step 2) 환경변수 fallback이 이미 적용됨 — config 읽기를 추가하려면 hermes config loader를 import해서 우선 시도.

- [ ] **Step 3: Codex OAuth expiry 체크**

`agent/codex_exec_client.py` (A1 경로) 또는 spawn site에서 첫 코드:

```python
def _check_codex_auth() -> Optional[str]:
    """Return None if OK, otherwise an error message to surface to the user."""
    auth_path = os.path.expanduser("~/.codex/auth.json")
    if not os.path.exists(auth_path):
        return "Codex auth.json 없음 — `codex login --device-auth` 실행 필요"
    try:
        import json, time
        with open(auth_path) as f:
            auth = json.load(f)
        # Codex auth format: {"tokens": {...}, "expires_at": "ISO-8601"} 또는 유사
        exp = auth.get("expires_at") or auth.get("tokens", {}).get("expires_at")
        if exp:
            from datetime import datetime
            exp_t = datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp()
            if time.time() > exp_t:
                return "Codex OAuth 만료 — `codex login --device-auth` 실행 필요"
    except Exception:
        pass  # 형식 불명이어도 무시 (실패는 spawn에서 잡힘)
    return None
```

`delegate_task_background`에서 spawn 전 호출:
```python
err = _check_codex_auth()
if err:
    return {"coder_run_id": None, "status": "auth_error", "error": err, "goal": goal}
```

Discord hook (Task 6 Step 5)에서 `status == "auth_error"`면 채널에 에러 메시지 표시.

- [ ] **Step 4: 부팅 + 라이브 확인**

```bash
systemctl --user restart hermes-gateway-main.service
sleep 5
journalctl --user -u hermes-gateway-main -n 30 --no-pager
```

- [ ] **Step 5: Commit**

```bash
cd ~/.hermes/hermes-agent
git add tools/delegate_tool.py agent/codex_exec_client.py
git commit -m "feat: coder config block + Codex OAuth expiry pre-check"
# config.yaml은 git tracking 밖
```

---

## Task 13: 통합 시나리오 라이브 테스트 + 점검

**Files:**
- (선택) Create: `~/.hermes/hermes-agent/tests/integration/test_coder_e2e.md` (수기 체크리스트)

이 task는 자동 테스트가 아니라 라이브 시나리오 walkthrough. 각 시나리오 결과를 체크리스트에 기록.

- [ ] **Step 1: Golden path**

Discord 봇 채널에서 `@Hermes /tmp/scratch.py에 hello world 출력하는 main 함수 추가해줘`.
Expected: 자동 위임 → 스레드 생성 → `🔧 reading`, `✏️ editing`, `✅ 완료`. `/tmp/scratch.py` 실제 파일 생성됨.

- [ ] **Step 2: `/code` 명시 트리거**

봇 채널: `/code echo "from /code slash"`.
Expected: 스레드 + `▶️ $ echo ...` + 출력.

- [ ] **Step 3: CJK 진행 메시지**

봇 채널: `@Hermes 한국어로 README 한 줄 요약을 /tmp/summary.md에 써줘`.
Expected: 스레드 진행 메시지의 한국어가 단어 사이 공백 보존 + 단어 내 공백 끼지 않음.

- [ ] **Step 4: 동시 코더 2개**

연속으로 두 번 코딩 요청 → 스레드 2개 동시 생성. 진행 이벤트가 서로 섞이지 않는지 확인.

- [ ] **Step 5: Follow-up**

스레드 안에서 추가 요청 (`그리고 docstring도 붙여줘`). 같은 스레드에 추가 진행 + 완료.

- [ ] **Step 6: 취소**

새 코딩 요청 → 스레드에 `cancel` 즉시 → `❌ 취소됨` + 진행 중단.

- [ ] **Step 7: max_concurrent 초과**

세 번 spawn 후 네 번째 요청 → 채널에 `⚠️ max_concurrent (3) coder sessions active.`.

- [ ] **Step 8: OAuth 만료 시뮬레이션**

```bash
mv ~/.codex/auth.json ~/.codex/auth.json.bak
```
봇 채널: 코딩 요청. Expected: `❌ Codex auth.json 없음 — codex login --device-auth 실행 필요`.
복원: `mv ~/.codex/auth.json.bak ~/.codex/auth.json`.

- [ ] **Step 9: 결과 기록**

각 시나리오 PASS/FAIL을 `tests/integration/test_coder_e2e.md`에 기록 + FAIL 케이스는 issue로 follow-up 결정 (V2 또는 즉시 hotfix).

- [ ] **Step 10: 메모리 업데이트**

새 메모 `project_hermes_coder_subagent.md` 작성:
- 가동 상태, 채택 경로 (A or A1), config 위치, 운영 노트
- 알려진 한계 (V1 제외 항목, ACP session resume 미지원 등)
- 향후 V2 후보

- [ ] **Step 11: Final commit**

```bash
cd ~/.hermes/hermes-agent
git status
git add -A  # but inspect first to avoid committing accidental local files
git commit -m "test: coder sub-agent e2e walkthrough results"
```

---

## Self-Review Notes (post-write)

체크 완료 항목:
- **Spec coverage**: 섹션 4 (Components) 1~8번 각각 task 매핑 — 1→Task 12, 2→Task 12+OS, 3→Task 3, 4→Task 6, 5→Task 2분기, 6→Task 8, 7→Task 9, 8→영속화 V2 deferred (V1은 in-memory).
- **No placeholders**: 각 step에 실제 코드 또는 grep 앵커 + 정확한 명령. `<Task 1 결과>` 같은 마커는 분기 의도 명시 (placeholder 아님).
- **Type consistency**: `coder_run_id`, `thread_id`, `parent_channel_id` 일관. `_coder_sessions`, `_coder_flusher` 인스턴스 attribute 이름 일관.

남은 우려:
- Task 6 Step 5의 메시지 핸들러 정확한 hook 위치 — `discord.py` 5005줄이라 실제 위치는 grep으로 결정. 위치 잘못 잡으면 hook이 안 걸림 → Task 6 Step 8 라이브 smoke가 회귀 감지.
- Task 8 `_get_active_agent_for_user` 같은 helper의 실제 이름 — grep으로 확정 필요.
- ACP session resume 미지원 시 follow-up이 새 spawn으로 fallback (Task 10 Step 2 노트) — V1 의도된 trade-off.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-hermes-coder-subagent.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. 큰 plan이라 task-by-task 분리하는 게 안전.

**2. Inline Execution** — 같은 세션에서 batch checkpoint 단위로 진행.

어느 쪽으로 갈까?
