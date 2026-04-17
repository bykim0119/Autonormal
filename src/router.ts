import { store as defaultStore, createStore, Message } from './store';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL || 'gemma4:e4b-it-q4_K_M';

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
      body: JSON.stringify({ model, messages, stream: false, options: { num_predict: 512 } }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { message: { content: string } };
    return data.message.content;
  } finally {
    clearTimeout(timer);
  }
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
  storeInstance.appendHistory(userId, 'user', userMessage);
  storeInstance.appendHistory(userId, 'assistant', ollamaResponse);
  return ollamaResponse;
}
