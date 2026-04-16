import express from 'express';
import { route } from './router';
import { store } from './store';
import { crawl, itemsToText } from './crawler';
import { registerSchedule, unregisterSchedule } from './scheduler';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;

// OpenClaw가 호출하는 OpenAI 호환 엔드포인트
// OpenClaw는 { messages, user } 형식으로 전송
app.post('/v1/chat/completions', async (req, res, next) => {
  try {
  const { messages, user } = req.body as {
    messages: Array<{ role: string; content: string }>;
    user?: string;
  };

  const userId = user || 'user_a';
  const totalChars = JSON.stringify(messages).length;
  const lastRole = messages[messages.length - 1]?.role;
  console.log(`[request] userId=${userId} messages=${messages.length} totalChars=${totalChars} lastRole=${lastRole}`);
  const lastMessage = messages[messages.length - 1];
  // content can be a string or an array of content parts (OpenAI multipart format)
  const rawContent = lastMessage?.content;
  const userText: string = Array.isArray(rawContent)
    ? rawContent.map((p: { type: string; text?: string }) => p.text ?? '').join('')
    : (rawContent as string) || '';
  console.log(`[userText] len=${userText.length} preview="${userText.slice(0, 80)}"`);

  // 설정 명령어 파싱: "모델 X로 바꿔줘"
  const modelMatch = userText.match(/모델\s+([\w:.-]+)(?:으?로|로)\s*바꿔/);
  if (modelMatch) {
    const newModel = modelMatch[1];
    store.setPreferredModel(userId, newModel);
    return res.json({
      choices: [{ message: { role: 'assistant', content: `모델을 ${newModel}으로 변경했습니다.` } }],
    });
  }

  // 모델 초기화: "모델 기본값으로 바꿔줘"
  if (userText.includes('모델') && userText.includes('기본값')) {
    store.setPreferredModel(userId, null);
    return res.json({
      choices: [{ message: { role: 'assistant', content: '모델을 기본값(Gemma4 E4B)으로 초기화했습니다.' } }],
    });
  }

  // 온디맨드 크롤링: "X 뉴스 N개 요약해줘"
  const crawlMatch = userText.match(/(.+?)\s+뉴스\s+(\d+)개?\s+요약/);
  if (crawlMatch) {
    const [, siteName, countStr] = crawlMatch;
    const count = parseInt(countStr, 10);
    const siteMap: Record<string, string> = {
      'geek': 'https://news.hada.io',
      'geek news': 'https://news.hada.io',
      'hacker news': 'https://news.ycombinator.com',
      'hn': 'https://news.ycombinator.com',
    };
    const targetUrl = siteMap[siteName.toLowerCase()] || `https://${siteName}`;
    const items = await crawl(targetUrl, count);
    const newsText = itemsToText(items);
    const prompt = `다음 뉴스를 각 항목별로 한 줄씩 한국어로 요약해줘:\n\n${newsText}`;
    const summary = await route(userId, prompt);
    return res.json({ choices: [{ message: { role: 'assistant', content: summary } }] });
  }

  // 일반 대화
    const response = await route(userId, userText);
    res.json({ choices: [{ message: { role: 'assistant', content: response } }] });
  } catch (err) {
    next(err);
  }
});

// 스케줄 등록 (Discord webhook URL과 cron 표현식 설정)
app.post('/v1/schedule', (req, res) => {
  const { userId, cronExpression, discordWebhookUrl } = req.body as {
    userId: string;
    cronExpression: string;
    discordWebhookUrl: string;
  };

  store.updateSetting(userId, 'news_schedule', cronExpression);
  registerSchedule(userId, cronExpression, discordWebhookUrl);
  res.json({ ok: true, message: `${userId} 스케줄 등록: ${cronExpression}` });
});

// 스케줄 해제
app.delete('/v1/schedule/:userId', (req, res) => {
  const { userId } = req.params;
  unregisterSchedule(userId);
  res.json({ ok: true, message: `${userId} 스케줄 해제` });
});

// 헬스체크
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// 전역 에러 핸들러
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`AI Router running on :${PORT}`);
});

export default app;
