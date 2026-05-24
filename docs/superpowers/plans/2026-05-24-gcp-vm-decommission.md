# GCP VM Decommission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GCP VM `autonormal` 인스턴스를 완전 delete + GCP 프로젝트 shutdown 하기 전, 잃으면 안 되는 시크릿·메모리·데이터를 user 로컬 머신으로 백업하고, 미푸시 코드/문서를 GitHub로 push 한다. 새 환경에서 복원할 수 있도록 runbook을 동봉한다.

**Architecture:** 3-트랙 구조. Track B(로컬 백업) → Track A(GitHub push) → Track C(외부 정리 확인) 순으로 진행. Restore runbook을 작성해 백업 tar.gz와 GitHub repo 양쪽에 동시에 보존 (한쪽이 잃어도 다른 쪽에서 접근 가능). 백업 검증 게이트 후 GitHub 작업 진행. VM delete는 user가 직접 실행.

**Tech Stack:** bash, git, tar, scp, gcloud (user 측 콘솔)

**Spec:** `docs/superpowers/specs/2026-05-24-gcp-vm-decommission-design.md`

---

## File Structure

이 plan은 운영 작업이라 코드 수정이 거의 없음. 변경되는 파일:

**Create:**
- `/home/bykim0119/autonormal/docs/runbooks/2026-05-24-vm-restore.md` — 새 환경 복원 가이드 (runbook)
- `/home/bykim0119/vm-backup-2026-05-24.tar.gz` — 백업 아카이브 (< 300K, scp 후 VM에서 제거)

**Modify:**
- `/home/bykim0119/autonormal/.gitignore` — `hermes-agent/` 추가 (별도 git repo)

**Delete:**
- `/home/bykim0119/autonormal/hermes-agent-issue.md` (5.4K)
- `/home/bykim0119/autonormal/hermes-agent-pr.md` (10.9K)
- `/home/bykim0119/autonormal/hermes-agent-pr-update.md` (3.4K)

**Stage (이미 untracked):**
- `/home/bykim0119/autonormal/docs/superpowers/specs/2026-05-18-hermes-coder-subagent-design.md`
- `/home/bykim0119/autonormal/docs/superpowers/plans/2026-05-18-hermes-coder-subagent.md`

**No code/test changes** — TDD 사이클 없음. 각 task는 "명령 실행 → 출력 확인" 패턴.

---

## Task 1: 백업 대상 존재 확인

**Files:**
- Inspect: `~/.claude/projects/-home-bykim0119-autonormal/memory/`
- Inspect: `~/autonormal/hermes-agent/.envrc`
- Inspect: `~/openclaw-quick-setup/openclaw.plugin.json`
- Inspect: `~/autonormal/ai-router/data/`

- [ ] **Step 1: 각 백업 대상이 실제로 존재하는지 확인**

Run:
```bash
ls -la ~/.claude/projects/-home-bykim0119-autonormal/memory/MEMORY.md \
       ~/autonormal/hermes-agent/.envrc \
       ~/openclaw-quick-setup/openclaw.plugin.json \
       ~/autonormal/ai-router/data/
```

Expected: 4개 경로 모두 정상 출력. 어느 하나라도 "No such file"이면 STOP — user에게 확인 받기.

- [ ] **Step 2: 각 대상 용량 합계 확인**

Run:
```bash
du -sb ~/.claude/projects/-home-bykim0119-autonormal/memory/ \
       ~/autonormal/hermes-agent/.envrc \
       ~/openclaw-quick-setup/openclaw.plugin.json \
       ~/autonormal/ai-router/data/ | awk '{s+=$1} END {printf "Total: %.1f KB\n", s/1024}'
```

Expected: Total < 500 KB. 500K 이상이면 user에게 보고 — 예상 외 큰 파일 포함됐을 수 있음.

---

## Task 2: Restore runbook 작성

**Files:**
- Create: `/home/bykim0119/autonormal/docs/runbooks/2026-05-24-vm-restore.md`

- [ ] **Step 1: runbooks 디렉토리 확인/생성**

Run:
```bash
mkdir -p /home/bykim0119/autonormal/docs/runbooks
ls /home/bykim0119/autonormal/docs/runbooks
```

Expected: 디렉토리 존재 (비어있어도 OK).

- [ ] **Step 2: runbook 파일 작성**

Create `/home/bykim0119/autonormal/docs/runbooks/2026-05-24-vm-restore.md` with exactly the following content:

````markdown
# VM Restore Runbook (2026-05-24 백업 기준)

GCP VM 폐기(2026-05-24) 시 저장된 백업으로 새 환경에 복원하는 절차.

## Prerequisites
- 새 환경에 git, Node.js (LTS), npm 설치
- GitHub 접근 권한 (`bykim0119/Autonormal`, `bykim0119/hermes-agent`, `bykim0119/openclaw-quick-setup`)
- 백업 아카이브: `vm-backup-2026-05-24.tar.gz` (로컬 머신에 보관 중)
- (선택) Claude Code 또는 동등한 환경 (메모리 활용 시)

## Step 1: GitHub repos clone

```bash
# 메인 워크스페이스 (예시 경로 — 자유롭게 변경)
mkdir -p ~/workspace && cd ~/workspace

# Autonormal (메인 repo)
git clone https://github.com/bykim0119/Autonormal.git autonormal

# hermes-agent fork (코더 서브에이전트 브랜치 포함)
mkdir -p ~/.hermes
git clone https://github.com/bykim0119/hermes-agent.git ~/.hermes/hermes-agent
cd ~/.hermes/hermes-agent
git remote add origin https://github.com/NousResearch/hermes-agent.git 2>/dev/null || true
git remote rename origin upstream 2>/dev/null || true
git remote rename origin fork 2>/dev/null || true
git checkout feature/coder-subagent

# OpenClaw quick-setup 플러그인
git clone https://github.com/bykim0119/openclaw-quick-setup.git ~/openclaw-quick-setup
```

## Step 2: 백업 tar.gz 풀기

```bash
mkdir -p ~/vm-restore && cd ~/vm-restore
tar -xzvf <백업파일-경로>/vm-backup-2026-05-24.tar.gz
ls -la
```

Expected: `.claude/`, `autonormal/`, `openclaw-quick-setup/` 디렉토리가 풀림.

## Step 3: 백업 파일을 원위치로

> **주의:** Claude 메모리 경로는 autonormal 디렉토리의 **절대경로 해시**에 따라 달라짐.
> 예: `/home/user/workspace/autonormal` → 해시는 `-home-user-workspace-autonormal`.
> 새 경로 기준으로 해시를 만들어서 그 자리에 메모리를 둬야 함.

```bash
cd ~/vm-restore

# 1) Claude memory → 새 환경의 ~/.claude/projects/<프로젝트-해시>/memory/
AUTONORMAL_PATH="$HOME/workspace/autonormal"   # 위에서 clone한 절대경로
NEW_PROJECT_HASH=$(echo "$AUTONORMAL_PATH" | sed 's|/|-|g')
mkdir -p ~/.claude/projects/$NEW_PROJECT_HASH/
cp -r .claude/projects/-home-bykim0119-autonormal/memory ~/.claude/projects/$NEW_PROJECT_HASH/
ls ~/.claude/projects/$NEW_PROJECT_HASH/memory/MEMORY.md   # 검증

# 2) hermes-agent .envrc
cp autonormal/hermes-agent/.envrc ~/.hermes/hermes-agent/.envrc
chmod 600 ~/.hermes/hermes-agent/.envrc

# 3) quick-setup plugin config
cp openclaw-quick-setup/openclaw.plugin.json ~/openclaw-quick-setup/

# 4) ai-router 사용자 데이터
mkdir -p ~/workspace/autonormal/ai-router/data
cp -r autonormal/ai-router/data/* ~/workspace/autonormal/ai-router/data/
```

## Step 4: 의존성 설치

```bash
cd ~/workspace/autonormal && npm install
cd ~/workspace/autonormal/ai-router && npm install
cd ~/.hermes/hermes-agent && npm install
cd ~/openclaw-quick-setup && npm install
```

## Step 5: 외부 시스템 재설정

| 시스템 | 액션 |
|--------|------|
| **Notion MCP OAuth callback URL** | 기존 콜백은 옛 VM의 9553 SSH 터널 가리킴. Notion Developer 페이지에서 새 환경의 콜백 URL로 갱신 필요. |
| **Discord bot** | `.envrc`의 token 재사용 가능. `direnv allow` 또는 `source .envrc` 후 hermes-agent 실행. |
| **Cloud Scheduler 잡** | GCP 떠났으므로 미복원. hermes-agent 내부 cron으로 대체. |
| **systemd unit** | 옛 VM 경로 기준이라 그대로 못 씀. 새 환경에서 새로 작성하거나 다른 supervisor 사용. |

## Step 6: 검증

- 각 repo `git status`: clean
- `cat ~/.claude/projects/$NEW_PROJECT_HASH/memory/MEMORY.md` — 메모리 인덱스 출력
- hermes-agent 실행 후 Discord에서 bot online 확인
- ai-router `curl http://localhost:<port>/health` 등 헬스체크

## 의도적으로 백업하지 않은 항목

다음은 복원할 필요 없음:
- `~/.config/gcloud/` — GCP 자격증명 (GCP 이탈)
- `/etc/systemd/system/*.service` — 옛 VM 경로 기준
- `hermes-cron-sync` 코드 — Cloud Scheduler 의존, 죽은 코드
- `~/autonormal/hermes-agent-{issue,pr,pr-update}.md` — 이미 PR 본문으로 쓰임
- `migration-backups/` — 컷오버 완료, 참조 가치 없음
- Claude 세션 트랜스크립트 (jsonl) — 메모리만 보존하면 충분
````

- [ ] **Step 3: 파일 생성 확인**

Run:
```bash
ls -la /home/bykim0119/autonormal/docs/runbooks/2026-05-24-vm-restore.md && \
wc -l /home/bykim0119/autonormal/docs/runbooks/2026-05-24-vm-restore.md
```

Expected: 파일 존재, 90줄 내외.

---

## Task 3: 백업 아카이브 생성 (runbook 포함)

**Files:**
- Create: `/home/bykim0119/vm-backup-2026-05-24.tar.gz`

- [ ] **Step 1: tar.gz 생성 (runbook도 포함)**

Run:
```bash
cd ~ && tar -czvf vm-backup-2026-05-24.tar.gz \
  .claude/projects/-home-bykim0119-autonormal/memory \
  autonormal/hermes-agent/.envrc \
  openclaw-quick-setup/openclaw.plugin.json \
  autonormal/ai-router/data \
  autonormal/docs/runbooks/2026-05-24-vm-restore.md
```

Expected: 각 파일 경로 출력, tar 에러 없음.

- [ ] **Step 2: 아카이브 무결성 검증**

Run:
```bash
tar -tzvf ~/vm-backup-2026-05-24.tar.gz && \
echo "---" && \
du -h ~/vm-backup-2026-05-24.tar.gz
```

Expected:
- runbook 파일이 listing에 등장
- memory, .envrc, plugin.json, ai-router/data 4개 경로 모두 포함
- 파일 크기 < 300K

- [ ] **Step 3: 체크포인트 — user에게 보고**

user에게 다음을 보고:
- 아카이브 생성 완료, 위치: `~/vm-backup-2026-05-24.tar.gz`
- 크기 N KB
- runbook 포함됨 (압축 풀면 `autonormal/docs/runbooks/2026-05-24-vm-restore.md` 위치에 있음)
- **scp 명령어를 user 로컬에서 실행해야 함** (Step 4 안내)

- [ ] **Step 4: user에게 scp 명령어 안내**

user의 로컬 머신에서 실행할 명령:

```bash
# user 로컬에서 실행 — 일반 ssh
scp <vm-user>@<vm-ip>:~/vm-backup-2026-05-24.tar.gz ~/<로컬-경로>/

# 또는 gcloud 통해서
gcloud compute scp <vm-name>:~/vm-backup-2026-05-24.tar.gz ~/<로컬-경로>/ --zone=<zone>
```

user에게 "scp 완료 후 알려달라" 요청.

---

## Task 4: User 백업 검증 게이트

**Files:** 없음 (user 액션 + 보고)

- [ ] **Step 1: User에게 로컬 검증 요청**

user에게 안내:
> 로컬에서 다음을 실행해 내용 확인해줘:
> ```bash
> tar -tzvf ~/<로컬-경로>/vm-backup-2026-05-24.tar.gz
> ```
> 다음 5가지가 모두 들어있는지 확인:
> - `.claude/projects/-home-bykim0119-autonormal/memory/` (디렉토리)
> - `autonormal/hermes-agent/.envrc`
> - `openclaw-quick-setup/openclaw.plugin.json`
> - `autonormal/ai-router/data/` (디렉토리)
> - `autonormal/docs/runbooks/2026-05-24-vm-restore.md`

- [ ] **Step 2: 검증 응답 대기**

user 응답 케이스별 처리:
- "OK / 확인됨" → Task 5로 진행
- "X 빠짐" → Task 3 재실행, 해당 파일 확인
- "압축 못 풀겠다" → tar.gz 무결성 재검증 (`gzip -t`), 필요시 재생성

**검증 통과 전에는 Task 5 진행 금지.**

---

## Task 5: autonormal — draft md 3개 삭제

**Files:**
- Delete: `/home/bykim0119/autonormal/hermes-agent-issue.md`
- Delete: `/home/bykim0119/autonormal/hermes-agent-pr.md`
- Delete: `/home/bykim0119/autonormal/hermes-agent-pr-update.md`

- [ ] **Step 1: 삭제 전 존재 재확인**

Run:
```bash
ls -la /home/bykim0119/autonormal/hermes-agent-issue.md \
       /home/bykim0119/autonormal/hermes-agent-pr.md \
       /home/bykim0119/autonormal/hermes-agent-pr-update.md
```

Expected: 3개 모두 출력.

- [ ] **Step 2: 삭제**

Run:
```bash
rm /home/bykim0119/autonormal/hermes-agent-issue.md \
   /home/bykim0119/autonormal/hermes-agent-pr.md \
   /home/bykim0119/autonormal/hermes-agent-pr-update.md
```

Expected: 출력 없음 (성공).

- [ ] **Step 3: 삭제 확인**

Run:
```bash
cd /home/bykim0119/autonormal && git status --short | grep "hermes-agent-"
```

Expected: 출력 없음.

---

## Task 6: autonormal — .gitignore에 hermes-agent/ 추가

**Files:**
- Modify: `/home/bykim0119/autonormal/.gitignore`

- [ ] **Step 1: 현재 .gitignore 내용 확인**

Read `/home/bykim0119/autonormal/.gitignore` 전체 내용.

Expected: `hermes-agent/` 라인이 없음. 이미 있으면 Step 2 skip.

- [ ] **Step 2: hermes-agent/ 라인 추가**

`.gitignore` 파일 끝에 다음 한 줄 append (Edit tool 사용):
```
hermes-agent/
```

- [ ] **Step 3: 효과 확인**

Run:
```bash
cd /home/bykim0119/autonormal && git status --short | grep -E "hermes-agent/?$"
```

Expected: 출력 없음.

---

## Task 7: autonormal — runbook + coder docs + plan commit + push

**Files:**
- Stage: `/home/bykim0119/autonormal/docs/runbooks/2026-05-24-vm-restore.md`
- Stage: `/home/bykim0119/autonormal/docs/superpowers/specs/2026-05-18-hermes-coder-subagent-design.md`
- Stage: `/home/bykim0119/autonormal/docs/superpowers/plans/2026-05-18-hermes-coder-subagent.md`
- Stage: `/home/bykim0119/autonormal/docs/superpowers/plans/2026-05-24-gcp-vm-decommission.md`
- Modify: `/home/bykim0119/autonormal/.gitignore` (Task 6에서 변경)

- [ ] **Step 1: 스테이징 대상 점검**

Run:
```bash
cd /home/bykim0119/autonormal && git status --short
```

Expected 출력 (정확히 이 5줄이어야 함):
```
 M .gitignore
?? docs/runbooks/2026-05-24-vm-restore.md
?? docs/superpowers/plans/2026-05-18-hermes-coder-subagent.md
?? docs/superpowers/plans/2026-05-24-gcp-vm-decommission.md
?? docs/superpowers/specs/2026-05-18-hermes-coder-subagent-design.md
```

만약 hermes-agent-*.md가 남아있거나 다른 untracked 파일 보이면 STOP — user에게 보고.

- [ ] **Step 2: 3개 commit으로 분리**

(a) coder-subagent docs + .gitignore:
```bash
cd /home/bykim0119/autonormal && git add .gitignore \
  docs/superpowers/specs/2026-05-18-hermes-coder-subagent-design.md \
  docs/superpowers/plans/2026-05-18-hermes-coder-subagent.md && \
git commit -m "$(cat <<'EOF'
docs: coder subagent design/plan + ignore hermes-agent fork

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

(b) decommission plan:
```bash
cd /home/bykim0119/autonormal && git add \
  docs/superpowers/plans/2026-05-24-gcp-vm-decommission.md && \
git commit -m "$(cat <<'EOF'
docs: GCP VM decommission implementation plan

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

(c) restore runbook:
```bash
cd /home/bykim0119/autonormal && git add \
  docs/runbooks/2026-05-24-vm-restore.md && \
git commit -m "$(cat <<'EOF'
docs: VM restore runbook for new environment

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Expected: 3개의 commit 출력, 각 해시 표시.

- [ ] **Step 3: git status clean 확인**

Run:
```bash
cd /home/bykim0119/autonormal && git status --short
```

Expected: 출력 비어 있음.

- [ ] **Step 4: push 전 ahead 확인**

Run:
```bash
cd /home/bykim0119/autonormal && git log --oneline origin/main..HEAD
```

Expected: 새 commit들 포함, 8~9개 commit 출력 (기존 5 + spec + 위 3개 ≈ 9).

- [ ] **Step 5: push**

Run:
```bash
cd /home/bykim0119/autonormal && git push origin main
```

Expected: "Writing objects" → "main -> main". 에러 없음.

- [ ] **Step 6: push 후 상태 확인**

Run:
```bash
cd /home/bykim0119/autonormal && git status && git log --oneline -5
```

Expected:
- `Your branch is up to date with 'origin/main'`
- 최근 commit들이 origin과 동일

---

## Task 8: hermes-agent fork — push 상태 재확인

**Files:** 없음 (확인만)

사전 확인에서 fork의 `feature/coder-subagent`는 로컬과 sync 상태로 검증됨. 이 task는 그 상태가 유지되는지 재확인.

- [ ] **Step 1: 로컬 vs fork diff 확인**

Run:
```bash
cd /home/bykim0119/.hermes/hermes-agent && git fetch fork feature/coder-subagent 2>&1 | tail -3
git log --oneline fork/feature/coder-subagent..feature/coder-subagent
```

Expected: 두 번째 명령 출력이 **비어 있음** (fork가 로컬과 같음).

비어있지 않으면:
- 출력된 commit들을 user에게 보고
- `git push fork feature/coder-subagent` 실행
- 다시 비교

- [ ] **Step 2: 다른 브랜치도 push 필요한지 확인**

Run:
```bash
cd /home/bykim0119/.hermes/hermes-agent && git branch -vv
```

다음 브랜치들의 push 상태 보고:
- `pr-22335`, `pr-22395`, `pr-22408` — 이미 PR로 올라간 브랜치들 (fork에 있을 가능성 높음, 검증만)
- 기타 로컬-only 브랜치 발견 시 user에게 어떻게 할지 물어볼 것

**user 결정 후 push 진행.**

---

## Task 9: 외부 시스템 정리 — 확인 보고

**Files:** 없음 (확인만)

- [ ] **Step 1: 현재 running 서비스 확인**

Run:
```bash
systemctl list-units --type=service --state=running 2>/dev/null | grep -iE "(hermes|openclaw|ai-router|smallboss|cron-sync|tunnel)"
```

Expected: ai-router, hermes-cron-sync 등. user에게 출력 그대로 보고.

- [ ] **Step 2: Cloud Scheduler 잡 — user에게 안내만**

user에게 안내:
> GCP 프로젝트 통째로 shutdown 결정했으니 Cloud Scheduler 잡들은 자동 정리됨. 별도 액션 불필요. shutdown 30일 grace period 안엔 복구 가능.

- [ ] **Step 3: Notion MCP 9553 SSH 터널 — 새 환경 메모**

user에게 안내:
> Notion OAuth callback이 이 VM의 9553 SSH 터널을 가리키고 있어. 새 환경 셋업 시 Notion 통합 OAuth callback URL을 새 주소로 갱신 필요. **runbook Step 5에 명시되어 있음.**

- [ ] **Step 4: Discord bot — 새 환경 안내**

user에게 안내:
> VM delete 직후 Discord에서 hermes bot offline. 같은 token으로 새 환경에서 다시 가동하면 동일 bot 그대로 살아남. **runbook Step 5에 명시되어 있음.**

---

## Task 10: 백업 아카이브 정리 + 최종 상태 확인

**Files:**
- Delete: `/home/bykim0119/vm-backup-2026-05-24.tar.gz` (선택)

- [ ] **Step 1: Task 4 검증 게이트 통과 재확인**

user가 로컬에 백업 받았고 검증 OK했는지 다시 확인. **이게 확인 안 됐으면 절대 Step 2 진행 X.**

- [ ] **Step 2: VM 위 백업 아카이브 제거 (선택)**

Run:
```bash
rm ~/vm-backup-2026-05-24.tar.gz
```

(VM 어차피 곧 delete되므로 필수 아님. user가 두고 싶다 하면 skip.)

- [ ] **Step 3: 최종 git 상태 보고**

Run:
```bash
cd /home/bykim0119/autonormal && git status && echo "---" && git log --oneline origin/main..HEAD
```

Expected:
- `Your branch is up to date with 'origin/main'`
- 두 번째 명령 출력 비어 있음

- [ ] **Step 4: VM delete 안내**

user에게 최종 보고:
> 모든 백업/push 완료. runbook은 GitHub의 `autonormal/docs/runbooks/2026-05-24-vm-restore.md`와 로컬 tar.gz **양쪽**에 있음. 이제 GCP 콘솔/CLI에서 다음 실행해도 안전:
>
> 1. VM 인스턴스 delete (`gcloud compute instances delete <name> --zone=<zone>`)
> 2. GCP 프로젝트 shutdown (콘솔: IAM & Admin → Settings → SHUT DOWN)
>
> 30일 grace 안엔 복구 가능. 30일 후 영구 삭제.

---

## 성공 기준 체크리스트

전체 plan 완료 시점 자체 점검:
- [ ] `~/vm-backup-2026-05-24.tar.gz` 가 user 로컬에 존재하고 내용 검증 완료 (runbook 포함)
- [ ] `~/autonormal/docs/runbooks/2026-05-24-vm-restore.md` GitHub에 push 완료
- [ ] `~/autonormal/hermes-agent-{issue,pr,pr-update}.md` 3개 모두 삭제됨
- [ ] `~/autonormal/.gitignore`에 `hermes-agent/` 포함
- [ ] `~/autonormal` `git status`: clean, origin/main과 sync
- [ ] `~/.hermes/hermes-agent`의 `feature/coder-subagent`: fork와 sync
- [ ] 외부 시스템 (Discord, Notion, Cloud Scheduler) 상태 user에게 보고됨
- [ ] user가 VM delete 가능 상태임을 인지함
