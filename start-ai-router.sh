#!/bin/bash
OLLAMA_URL=http://localhost:11434 \
OLLAMA_TIMEOUT_MS=600000 \
OLLAMA_DEFAULT_MODEL=gemma4:e4b-it-q4_K_M \
nohup node /home/bykim0119/autonormal/ai-router/dist/index.js >> /tmp/ai-router.log 2>&1 &
echo "AI Router PID: $!"
