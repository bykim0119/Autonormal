# autonormal 운영 가이드

> 최종 업데이트: 2026-04-16  
> 환경: GCP VM · Tesla T4 · Ubuntu · Node 22 · Ollama gemma4:e4b-it-q4_K_M (~47 tok/sec)

---

## 현재 구성 요약

| 컴포넌트 | 경로 | 포트 | 상태 |
|---|---|---|---|
| Ollama | `/usr/local/bin/ollama` | 11434 | systemd 자동시작 ✅ |
| AI Router | `~/autonormal/ai-router/dist/index.js` | 4000 | 수동 시작 ⚠️ |
| OpenClaw Gateway | `~/autonormal/openclaw/scripts/run-node.mjs gateway` | 18789 | 수동 시작 ⚠️ |
| Discord 봇 (Hermes) | openclaw 내장 | — | OpenClaw 기동 시 자동 연결 |

설정 파일: `~/.openclaw/openclaw.json`

---

## 1. 자동 시작 설정 (systemd)

VM 재시작 시 AI Router와 OpenClaw가 자동으로 올라오도록 systemd 서비스를 등록한다.

### 1-1. AI Router 서비스 등록

```bash
sudo tee /etc/systemd/system/ai-router.service > /dev/null <<'EOF'
[Unit]
Description=autonormal AI Router
After=network-online.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=bykim0119
WorkingDirectory=/home/bykim0119/autonormal/ai-router
Environment="OLLAMA_URL=http://localhost:11434"
Environment="OLLAMA_TIMEOUT_MS=600000"
Environment="OLLAMA_DEFAULT_MODEL=gemma4:e4b-it-q4_K_M"
ExecStart=/usr/bin/node /home/bykim0119/autonormal/ai-router/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/tmp/ai-router.log
StandardError=append:/tmp/ai-router.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ai-router
sudo systemctl start ai-router
sudo systemctl status ai-router
```

### 1-2. OpenClaw Gateway 서비스 등록

```bash
sudo tee /etc/systemd/system/openclaw.service > /dev/null <<'EOF'
[Unit]
Description=OpenClaw Gateway
After=network-online.target ai-router.service
Wants=ai-router.service

[Service]
Type=simple
User=bykim0119
WorkingDirectory=/home/bykim0119/autonormal/openclaw
ExecStart=/usr/bin/node scripts/run-node.mjs gateway
Restart=on-failure
RestartSec=5
StandardOutput=append:/tmp/openclaw-gateway.log
StandardError=append:/tmp/openclaw-gateway.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable openclaw
sudo systemctl start openclaw
sudo systemctl status openclaw
```

> Ollama는 이미 systemd에 등록되어 자동 시작됨 (`systemctl is-enabled ollama` → enabled)

### 1-3. 서비스 상태 확인

```bash
systemctl status ollama ai-router openclaw
```

### 1-4. 로그 확인

```bash
tail -f /tmp/ai-router.log          # AI Router
tail -f /tmp/openclaw-gateway.log   # OpenClaw Gateway
journalctl -u ollama -f             # Ollama
```

### 1-5. 재시작 순서

```bash
sudo systemctl restart ollama
sudo systemctl restart ai-router
sudo systemctl restart openclaw
```

---

## 2. 추가해야 할 OpenClaw 기능

현재 `~/.openclaw/openclaw.json`은 Discord 채널만 활성화된 최소 구성이다.  
아래는 OpenClaw가 지원하는 주요 기능과 활성화 방법이다.

### 2-1. 로컬 모델 경량화 (우선 적용 권장)

gemma4는 컨텍스트가 작으므로 무거운 기본 툴을 줄이면 응답 속도와 품질이 향상된다.

```jsonc
// ~/.openclaw/openclaw.json > agents.defaults 수정
"agents": {
  "defaults": {
    "model": "local-router/gemma4:e4b-it-q4_K_M",
    "contextTokens": 32000,
    "experimental": {
      "localModelLean": true   // browser, cron, message 등 무거운 툴 자동 제외
    },
    "llm": {
      "idleTimeoutSeconds": 600
    }
  }
}
```

### 2-2. 메모리 (Memory)

대화 내용을 장기 저장하고 다음 세션에서 자동으로 불러온다.

```jsonc
"plugins": {
  "entries": {
    "memory-core": {
      "enabled": true
    }
  }
}
```

- 메모리 파일 저장 위치: `~/.openclaw/memory/`
- 벡터 검색이 필요하면 `memory-lancedb` 플러그인 추가 (LanceDB 별도 설치 필요)

### 2-3. 웹 검색 (Web Search)

모델이 인터넷 검색을 할 수 있게 한다.

```jsonc
"plugins": {
  "entries": {
    "web-search": {
      "enabled": true,
      "config": {
        "provider": "brave"   // "serpapi", "google" 도 가능
      }
    }
  }
}
```

- Brave Search API 키 필요: https://api.search.brave.com
- 환경변수 `BRAVE_SEARCH_API_KEY` 또는 `webSearch.apiKey`로 주입

### 2-4. 크론 예약 메시지 (Cron)

정해진 시간에 자동으로 메시지를 보낸다.

```jsonc
"cron": {
  "enabled": true
}
```

Discord에서 사용 예:
```
/cron add "0 9 * * 1-5" geek news 5개 요약해줘
```

### 2-5. 브라우저 도구 (Browser)

현재 이미 활성화되어 있음 (기동 로그: `6 plugins: ... browser ...`).  
별도 설정 없이 "이 URL 요약해줘" 형태로 사용 가능.

### 2-6. TTS (Discord 음성)

Discord 음성 채널에서 봇이 말할 수 있다.

```jsonc
"channels": {
  "discord": {
    // ... 기존 설정 ...
    "voice": {
      "tts": {
        "auto": true
      }
    }
  }
}
```

- **클라우드**: Microsoft Azure TTS 또는 ElevenLabs API 키 필요
- **로컬(오프라인)**: `sherpa-onnx-tts` 스킬 설치

### 2-7. 유용한 스킬 설치

```bash
# OpenClaw 스킬 설치 (openclaw 디렉토리에서)
cd ~/autonormal/openclaw
node scripts/run-node.mjs skills add weather
node scripts/run-node.mjs skills add summarize
node scripts/run-node.mjs skills add github
```

| 스킬 | 기능 |
|---|---|
| `weather` | 날씨 조회 |
| `summarize` | 긴 텍스트/URL 요약 |
| `github` | GitHub 이슈/PR 조회 |
| `canvas` | 시각적 캔버스 렌더링 |
| `notion` | Notion 페이지 연동 |
| `coding-agent` | 코딩 전용 에이전트 |
| `session-logs` | 대화 로그 내보내기 |
| `model-usage` | 모델 사용량 통계 |

---

## 3. AI Router 현재 동작

### 흐름

```
Discord → OpenClaw Gateway (:18789)
       → AI Router (:4000)        ← stream: true SSE 응답
       → Ollama (:11434)          ← gemma4:e4b-it-q4_K_M
         ↓ (LLM-as-judge: no)
       → Codex fallback (CODEX_API_KEY 설정 시)
         ↓ (Codex 실패)
       → "[로컬 모델 응답]" + Ollama 응답 반환
```

### 지원 명령어

| 입력 패턴 | 동작 |
|---|---|
| 일반 텍스트 | Ollama gemma4로 대화 |
| `모델 [이름]으로 바꿔줘` | 사용자별 모델 변경 |
| `모델 기본값으로 바꿔줘` | 모델 초기화 |
| `[사이트] 뉴스 [N]개 요약해줘` | 웹 크롤링 후 요약 |

지원 사이트: `geek` / `geek news` (GeekNews), `hacker news` / `hn`

### 히스토리 영속화 (미구현)

현재 대화 히스토리는 메모리에만 유지되어 VM 재시작 시 초기화된다.  
영속화가 필요하면 `ai-router/src/store.ts`의 `DATA_DIR`를 활용해 `ai-router/data/` 에 JSON 저장 중인 로직을 systemd restart 시에도 살아남도록 경로를 고정하면 된다 (현재 이미 파일 저장 로직은 있으나 재시작 후 재로드 여부 확인 필요).

---

## 4. 트러블슈팅

### Discord에서 응답이 없을 때

```bash
# 1. AI Router 헬스 확인
curl http://localhost:4000/health

# 2. Ollama 확인
curl http://localhost:11434/api/tags

# 3. OpenClaw 최근 로그
tail -50 /tmp/openclaw-gateway.log
```

### 스트리밍 오류 (`payloads=0`)

OpenClaw는 `stream: true`로 SSE 스트리밍을 요구한다.  
AI Router가 일반 JSON을 반환하면 `payloads=0` 에러가 발생한다.  
현재 `ai-router/src/index.ts`에 `sendStreaming()` 함수로 수정 완료.

### AI Router 빌드 및 재배포

```bash
cd ~/autonormal/ai-router
node_modules/.bin/tsc -p tsconfig.build.json
sudo systemctl restart ai-router   # systemd 등록 후
```
