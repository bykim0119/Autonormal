import { callOllama, route } from '../src/router';
import { createStore } from '../src/store';
import os from 'os';
import path from 'path';
import fs from 'fs';

// fetch mock
global.fetch = jest.fn();

const TEST_DIR = path.join(os.tmpdir(), `ai-router-router-test-${process.pid}`);
const testStore = createStore(TEST_DIR);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  jest.clearAllMocks();
});
afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('callOllama', () => {
  it('Ollama 응답 텍스트 반환', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: '안녕하세요!' } }),
    });

    const result = await callOllama('gemma4:e4b-it-q4_K_M', [{ role: 'user', content: '안녕' }]);
    expect(result).toBe('안녕하세요!');
  });

  it('타임아웃 시 에러 발생', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 100))
    );
    await expect(
      callOllama('gemma4:e4b-it-q4_K_M', [{ role: 'user', content: '안녕' }], 50)
    ).rejects.toThrow();
  });
});

describe('route', () => {
  it('Ollama 응답을 바로 반환', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: '좋은 답변입니다' } }),
    });

    const result = await route('user_a', '안녕', testStore);
    expect(result).toBe('좋은 답변입니다');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('히스토리에 user/assistant 메시지가 추가됨', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: '응답' } }),
    });

    await route('user_b', '질문', testStore);
    const history = testStore.getUserData('user_b').history;
    expect(history).toContainEqual({ role: 'user', content: '질문' });
    expect(history).toContainEqual({ role: 'assistant', content: '응답' });
  });
});
