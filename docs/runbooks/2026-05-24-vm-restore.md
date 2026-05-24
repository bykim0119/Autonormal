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
# 원본 upstream과 fork 둘 다 트래킹
git remote rename origin fork
git remote add upstream https://github.com/NousResearch/hermes-agent.git
git fetch --all
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
