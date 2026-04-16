import cron, { ScheduledTask } from 'node-cron';
import { crawl, itemsToText } from './crawler';
import { route } from './router';
import { store } from './store';

const activeJobs = new Map<string, ScheduledTask>();

export function registerSchedule(
  userId: string,
  cronExpression: string,
  discordWebhookUrl: string
): void {
  if (activeJobs.has(userId)) {
    activeJobs.get(userId)!.stop();
    activeJobs.delete(userId);
  }

  const job = cron.schedule(cronExpression, async () => {
    try {
      const settings = store.getUserData(userId).settings;
      const sources = (settings['news_sources'] as string[]) || ['https://news.hada.io'];
      const count = (settings['news_count'] as number) || 5;

      const allItems = [];
      for (const source of sources) {
        const items = await crawl(source, count);
        allItems.push(...items);
      }

      const newsText = itemsToText(allItems.slice(0, count));
      const prompt = `다음 뉴스를 각 항목별로 한 줄씩 한국어로 요약해줘:\n\n${newsText}`;
      const summary = await route(userId, prompt);

      await fetch(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `📰 **오늘의 뉴스 요약**\n\n${summary}` }),
      });
    } catch (err) {
      console.error(`[scheduler] ${userId} 스케줄 실행 오류:`, err);
    }
  });

  activeJobs.set(userId, job);
}

export function unregisterSchedule(userId: string): void {
  if (activeJobs.has(userId)) {
    activeJobs.get(userId)!.stop();
    activeJobs.delete(userId);
  }
}
