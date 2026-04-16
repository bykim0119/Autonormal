"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crawler_1 = require("../src/crawler");
// Playwright mock
jest.mock('playwright', () => ({
    chromium: {
        launch: jest.fn().mockResolvedValue({
            newPage: jest.fn().mockResolvedValue({
                goto: jest.fn().mockResolvedValue(null),
                evaluate: jest.fn().mockResolvedValue([
                    { title: '테스트 뉴스 1', url: 'https://example.com/1', snippet: '내용 1' },
                    { title: '테스트 뉴스 2', url: 'https://example.com/2', snippet: '내용 2' },
                ]),
                close: jest.fn(),
            }),
            close: jest.fn(),
        }),
    },
}));
describe('crawl', () => {
    it('지정된 URL에서 아이템 목록 반환', async () => {
        const items = await (0, crawler_1.crawl)('https://news.hada.io', 5);
        expect(items).toHaveLength(2);
        expect(items[0]).toHaveProperty('title');
        expect(items[0]).toHaveProperty('url');
        expect(items[0]).toHaveProperty('snippet');
    });
    it('count 제한 적용', async () => {
        const items = await (0, crawler_1.crawl)('https://news.hada.io', 1);
        expect(items.length).toBeLessThanOrEqual(1);
    });
});
