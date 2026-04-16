import { chromium } from 'playwright';

export interface CrawlItem {
  title: string;
  url: string;
  snippet: string;
}

export async function crawl(targetUrl: string, count: number): Promise<CrawlItem[]> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const items = await page.evaluate(() => {
      // 범용 콘텐츠 추출: a 태그 기반으로 제목/링크 수집
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .filter((a) => {
          const text = a.textContent?.trim() || '';
          return text.length > 20 && (a as HTMLAnchorElement).href.startsWith('http');
        })
        .map((a) => ({
          title: a.textContent?.trim() || '',
          url: (a as HTMLAnchorElement).href,
          snippet: a.parentElement?.textContent?.trim().slice(0, 200) || '',
        }));
    });

    await page.close();
    return items.slice(0, count);
  } finally {
    await browser.close();
  }
}

export function itemsToText(items: CrawlItem[]): string {
  return items
    .map((item, i) => `${i + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`)
    .join('\n\n');
}
