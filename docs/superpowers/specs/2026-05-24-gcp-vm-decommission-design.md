# GCP VM Decommission — Design

**날짜:** 2026-05-24
**범위:** GCP VM `autonormal` 인스턴스 완전 delete + GCP 프로젝트 shutdown 전 안전 백업

## 1. 목표·전제·범위

### 목표
오늘 안에 GCP VM이 완전히 delete되어도 잃을 게 없는 상태를 만든다. 새 환경 셋업과 서비스 재가동은 며칠 걸쳐 별도로 진행한다.

### 전제 (확정된 결정)
1. **VM 운명:** 완전 delete (백업 없이)
2. **서비스 운명:** 다른 환경으로 이주 (오늘 안엔 가동 안 함)
3. **오늘 목표:** 안전 백업까지만
4. **백업 위치:** GitHub (코드/문서) + 로컬 머신 (시크릿/상태)
5. **GCP 완전 이탈:** gcloud creds, hermes-cron-sync 서비스, Cloud Scheduler 잡, systemd unit 파일은 백업 대상에서 제외
6. **GCP 프로젝트:** 통째로 shutdown (30일 grace period)

### 범위 밖 (오늘 안 함)
- 새 환경 셋업
- 서비스 재기동
- Discord/Notion OAuth callback 주소 갱신
- 이주된 서비스의 동작 검증

### 성공 기준
- 모든 미푸시 코드/문서가 GitHub remote에 도달
- 잃으면 안 되는 시크릿·메모리·데이터가 로컬 머신에 한 덩어리로 존재
- VM `gcloud compute instances delete` 실행 가능한 상태

## 2. 작업 트랙

### Track A — GitHub로 push (코드/문서)

| 항목 | 위치 | 액션 |
|------|------|------|
| `autonormal` main 5 commits ahead (docs) | `~/autonormal` | `git push origin main` |
| Untracked: coder-subagent design + plan 2개 | `~/autonormal/docs/superpowers/{specs,plans}/2026-05-18-hermes-coder-subagent*.md` | commit + push |
| Untracked: hermes-agent draft md 3개 (19.6K) | `~/autonormal/hermes-agent-{issue,pr,pr-update}.md` | **삭제** (이미 PR 본문으로 쓰임) |
| Untracked: `hermes-agent/` 디렉토리 | `~/autonormal/hermes-agent/` | `.gitignore`에 추가 (별도 git repo) |
| `hermes-agent` fork: `feature/coder-subagent` 24 commits ahead | 위치 확인 필요 | fork remote에 push |

### Track B — 로컬 머신으로 백업 (시크릿/상태)

단일 `tar.gz`로 묶어 user 로컬 머신으로 `scp`. 합쳐서 < 300K.

| 항목 | 경로 | 용량 |
|------|------|------|
| Claude 메모리 | `~/.claude/projects/-home-bykim0119-autonormal/memory/` | 196K |
| hermes-agent `.envrc` | `~/autonormal/hermes-agent/.envrc` | ~KB |
| quick-setup plugin config | `~/openclaw-quick-setup/openclaw.plugin.json` | ~KB |
| ai-router 사용자 데이터 | `~/autonormal/ai-router/data/*.json` | ~KB |

**파일명:** `vm-backup-2026-05-24.tar.gz`

### Track C — 외부 시스템 정리

| 항목 | 처리 |
|------|------|
| Discord bot (hermes-agent) | VM 죽으면 자동 offline. 별도 액션 X |
| Cloud Scheduler 잡들 | GCP 프로젝트 shutdown 시 자동 정리 |
| Notion MCP OAuth callback (9553 SSH 터널) | 새 환경 셋업 시 재구성 (오늘 X) |
| GCP 프로젝트 | 통째로 shutdown (30일 grace) |

### 버려지는 것 (의도적으로 백업 안 함)

| 항목 | 사유 |
|------|------|
| `hermes-cron-sync/` (66M, 코드 28K) | Cloud Scheduler 의존, GCP 떠나면 죽은 코드 |
| `hermes-agent-{issue,pr,pr-update}.md` (19.6K) | 이미 PR 본문으로 사용됨 |
| `migration-backups/` (648K) | 컷오버 완료, 참조 가치 없음 |
| Claude 세션 트랜스크립트 jsonl (31M) | 메모리만 보존하면 충분 |
| gcloud 자격증명 (`~/.config/gcloud/`) | GCP 떠남 |
| systemd unit 3개 | 이 VM 경로 기준, 새 환경엔 그대로 못 씀 |
| `~/autonormal/openclaw/` (3.4G) | 이미 GitHub에 있는 클론 |
| node_modules 전체 | `npm install`로 복원 |

## 3. 실행 단계

### Phase 1 — 사전 확인
1. `hermes-agent` fork의 `feature/coder-subagent` 브랜치 실제 위치 확인 (메모리상 24 commits ahead인데 `~/autonormal/hermes-agent`에 안 보임)
2. `hermes-agent` fork push 권한 확인
3. user 로컬 머신의 scp 수신 경로 확인

### Phase 2 — Track B (로컬 백업 먼저)
1. 백업 대상을 `vm-backup-2026-05-24.tar.gz`로 묶음
2. user가 로컬에서 `scp`로 받음 (명령어는 Claude가 제공)
3. user가 로컬에서 압축 풀어 내용 확인 (**검증 게이트**)

### Phase 3 — Track A (GitHub push)

**A-1. autonormal 정리**
- draft md 3개 삭제: `rm hermes-agent-{issue,pr,pr-update}.md`
- `.gitignore`에 `hermes-agent/` 추가
- coder-subagent docs 2개 commit
- `git push origin main`

**A-2. hermes-agent fork push**
- Phase 1에서 확인한 위치에서 `feature/coder-subagent` 브랜치를 fork remote에 push

### Phase 4 — Track C 외부 정리
오늘 액션 없음. 모두 VM/프로젝트 delete로 자동 정리됨.

### Phase 5 — VM delete (user 직접 실행)
1. VM 인스턴스 delete
2. GCP 프로젝트 shutdown (30일 grace)

Claude는 이 단계 직접 실행 X.

## 4. 성공 기준 체크리스트

- [ ] 로컬에 `vm-backup-2026-05-24.tar.gz` 받아 내용 확인 완료
- [ ] `git push origin main` (autonormal) 성공, draft md 3개 삭제됨
- [ ] hermes-agent fork에 coder-subagent 브랜치 push 성공
- [ ] VM delete 가능 상태 (참조할 로컬 자료 없음)
- [ ] user가 GCP 콘솔에서 VM delete + 프로젝트 shutdown

## 5. 예상 소요

사전 확인 5분 + 백업 5분 + push 15분 + 외부 정리 5분 ≈ **30분**
