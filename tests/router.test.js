"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const router_1 = require("../src/router");
const store_1 = require("../src/store");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
// fetch mock
global.fetch = jest.fn();
const TEST_DIR = path_1.default.join(os_1.default.tmpdir(), `ai-router-router-test-${process.pid}`);
const testStore = (0, store_1.createStore)(TEST_DIR);
beforeEach(() => {
    fs_1.default.mkdirSync(TEST_DIR, { recursive: true });
    jest.clearAllMocks();
});
afterEach(() => fs_1.default.rmSync(TEST_DIR, { recursive: true, force: true }));
describe('callOllama', () => {
    it('Ollama 응답 텍스트 반환', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ message: { content: '안녕하세요!' } }),
        });
        const result = await (0, router_1.callOllama)('gemma4:e4b-it-q4_K_M', [{ role: 'user', content: '안녕' }]);
        expect(result).toBe('안녕하세요!');
    });
    it('타임아웃 시 에러 발생', async () => {
        global.fetch.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 100)));
        await expect((0, router_1.callOllama)('gemma4:e4b-it-q4_K_M', [{ role: 'user', content: '안녕' }], 50)).rejects.toThrow();
    });
});
describe('judgeResponse', () => {
    it('"yes"로 시작하는 응답이면 true 반환', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ message: { content: 'yes' } }),
        });
        expect(await (0, router_1.judgeResponse)('질문', '답변', testStore)).toBe(true);
    });
    it('"no"로 시작하는 응답이면 false 반환', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ message: { content: 'no' } }),
        });
        expect(await (0, router_1.judgeResponse)('질문', '답변', testStore)).toBe(false);
    });
});
describe('route', () => {
    it('judge가 yes면 Ollama 응답 반환', async () => {
        global.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '좋은 답변입니다' } }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: 'yes' } }) });
        const result = await (0, router_1.route)('user_a', '안녕', testStore);
        expect(result).toBe('좋은 답변입니다');
        expect(global.fetch).toHaveBeenCalledTimes(2); // Ollama + judge
    });
    it('judge가 no이고 Codex 실패 시 "[로컬 모델 응답]" 포함 반환', async () => {
        global.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '짧은 답' } }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: 'no' } }) })
            .mockRejectedValueOnce(new Error('Codex API error'));
        const result = await (0, router_1.route)('user_a', '어려운 질문', testStore);
        expect(result).toContain('[로컬 모델 응답]');
    });
});
