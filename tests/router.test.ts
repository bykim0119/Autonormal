import { callOllama, judgeResponse, route } from '../src/router';
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

describe('judgeResponse', () => {
  it('"yes"로 시작하는 응답이면 true 반환', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: 'yes' } }),
    });
    expect(await judgeResponse('질문', '답변', testStore)).toBe(true);
  });

  it('"no"로 시작하는 응답이면 false 반환', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: 'no' } }),
    });
    expect(await judgeResponse('질문', '답변', testStore)).toBe(false);
  });
});

describe('route', () => {
  it('judge가 yes면 Ollama 응답 반환', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '좋은 답변입니다' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: 'yes' } }) });

    const result = await route('user_a', '안녕', testStore);
    expect(result).toBe('좋은 답변입니다');
    expect(global.fetch).toHaveBeenCalledTimes(2); // Ollama + judge
  });

  it('judge가 no이고 Codex 실패 시 "[로컬 모델 응답]" 포함 반환', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '짧은 답' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: 'no' } }) })
      .mockRejectedValueOnce(new Error('Codex API error'));

    const result = await route('user_a', '어려운 질문', testStore);
    expect(result).toContain('[로컬 모델 응답]');
  });
});
