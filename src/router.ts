import { store as defaultStore, createStore, Message } from './store';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL || 'gemma4:e4b-it-q4_K_M';
const CODEX_API_KEY = process.env.CODEX_API_KEY || '';
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.3-codex';

type Store = ReturnType<typeof createStore>;

export async function callOllama(
  model: string,
  messages: Message[],
  timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 15000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { message: { content: string } };
    return data.message.content;
  } finally {
    clearTimeout(timer);
  }
}

export async function judgeResponse(
  question: string,
  answer: string,
  storeInstance: Store = defaultStore
): Promise<boolean> {
  void storeInstance;
  const prompt = `질문: "${question}"\n답변: "${answer}"\n\n이 답변이 질문에 적절한가? "yes" 또는 "no"만 답해.`;
  const result = await callOllama(DEFAULT_MODEL, [{ role: 'user', content: prompt }]);
  return result.toLowerCase().trim().startsWith('yes');
}

async function callCodex(messages: Message[]): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CODEX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: CODEX_MODEL, messages }),
  });
  if (!res.ok) throw new Error(`Codex error: ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

export async function route(
  userId: string,
  userMessage: string,
  storeInstance: Store = defaultStore
): Promise<string> {
  const userData = storeInstance.getUserData(userId);
  const model = userData.preferred_model || DEFAULT_MODEL;
  const messages: Message[] = [...userData.history, { role: 'user', content: userMessage }];

  const ollamaResponse = await callOllama(model, messages);
  const isGood = await judgeResponse(userMessage, ollamaResponse, storeInstance);

  if (isGood) {
    storeInstance.appendHistory(userId, 'user', userMessage);
    storeInstance.appendHistory(userId, 'assistant', ollamaResponse);
    return ollamaResponse;
  }

  try {
    const codexResponse = await callCodex(messages);
    storeInstance.appendHistory(userId, 'user', userMessage);
    storeInstance.appendHistory(userId, 'assistant', codexResponse);
    return codexResponse;
  } catch {
    storeInstance.appendHistory(userId, 'user', userMessage);
    storeInstance.appendHistory(userId, 'assistant', ollamaResponse);
    return `[로컬 모델 응답]\n${ollamaResponse}`;
  }
}
