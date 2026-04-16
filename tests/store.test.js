"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const TEST_DIR = path_1.default.join(os_1.default.tmpdir(), `ai-router-store-test-${process.pid}`);
process.env.DATA_DIR = TEST_DIR;
const store_1 = require("../src/store");
const store = (0, store_1.createStore)(TEST_DIR);
const TEST_USER = 'user_test';
beforeEach(() => fs_1.default.mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => fs_1.default.rmSync(TEST_DIR, { recursive: true, force: true }));
describe('getUserData', () => {
    it('새 사용자는 기본값 반환', () => {
        expect(store.getUserData(TEST_USER)).toEqual({
            preferred_model: null,
            history: [],
            settings: {},
        });
    });
});
describe('setPreferredModel', () => {
    it('preferred_model 저장', () => {
        store.setPreferredModel(TEST_USER, 'gemma4:26b-a4b-q4_0');
        expect(store.getUserData(TEST_USER).preferred_model).toBe('gemma4:26b-a4b-q4_0');
    });
    it('null로 초기화', () => {
        store.setPreferredModel(TEST_USER, 'gemma4:26b-a4b-q4_0');
        store.setPreferredModel(TEST_USER, null);
        expect(store.getUserData(TEST_USER).preferred_model).toBeNull();
    });
});
describe('appendHistory', () => {
    it('메시지 추가', () => {
        store.appendHistory(TEST_USER, 'user', '안녕');
        store.appendHistory(TEST_USER, 'assistant', '반갑습니다');
        expect(store.getUserData(TEST_USER).history).toHaveLength(2);
    });
    it('20개 초과 시 오래된 것부터 제거', () => {
        for (let i = 0; i < 25; i++) {
            store.appendHistory(TEST_USER, 'user', `msg ${i}`);
        }
        const history = store.getUserData(TEST_USER).history;
        expect(history).toHaveLength(20);
        expect(history[0].content).toBe('msg 5');
    });
});
describe('updateSetting', () => {
    it('임의 키-값 저장', () => {
        store.updateSetting(TEST_USER, 'news_schedule', '0 9 * * *');
        expect(store.getUserData(TEST_USER).settings['news_schedule']).toBe('0 9 * * *');
    });
    it('기존 설정 덮어쓰기', () => {
        store.updateSetting(TEST_USER, 'count', 5);
        store.updateSetting(TEST_USER, 'count', 10);
        expect(store.getUserData(TEST_USER).settings['count']).toBe(10);
    });
});
