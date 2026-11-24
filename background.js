/* ============================================================
 * 智慧树刷题助手 · Background Service Worker
 * 负责代理 LLM 请求（content script 直连会被页面 CORS 拦），
 * 并负责格式化大模型返回的答案。
 * ============================================================ */

const DEFAULTS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4-flash',
};

const LETTERS = 'ABCDEFGH';

const TYPE_NAME = {
  single: '单选题',
  multi: '多选题',
  judge: '判断题',
  blank: '填空题',
  short: '简答/论述题',
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || (msg.type !== 'zhxs-ask' && msg.type !== 'zhxs-test')) return false;

  (async () => {
    try {
      const cfg = await chrome.storage.sync.get(DEFAULTS);
      if (!cfg.apiKey) {
        sendResponse({ ok: false, error: '未配置 API Key：点击浏览器工具栏的助手图标进行设置' });
        return;
      }
      if (msg.type === 'zhxs-test') {
        const raw = await chat(cfg, [
          { role: 'user', content: '收到请只回复两个字：成功' },
        ]);
        sendResponse({ ok: true, raw });
        return;
      }
      const answer = await askQuestion(cfg, msg.payload);
      sendResponse({ ok: true, answer });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true; // 异步 sendResponse
});

/* ---------- 核心问答 ---------- */

async function askQuestion(cfg, payload) {
  const { qType, stem, options = [] } = payload;
  const system = [
    '你是高校网课答题助手，根据题目给出最可能的答案。',
    '严格遵守输出格式，禁止任何解释、前缀和多余内容：',
    '- 单选题：只输出一个选项字母，例如 B',
    '- 多选题：只输出选项字母组合，例如 ABD',
    '- 判断题：只输出「正确」或「错误」',
    '- 填空题：只输出答案文本，多个空用 || 分隔',
    '- 简答/论述题：用两三句话简明作答',
  ].join('\n');

  const lines = [`题型：${TYPE_NAME[qType] || qType}`, `题干：${stem}`];
  if (options.length) {
    lines.push('选项：');
    options.forEach((o, i) => lines.push(`${LETTERS[i]}. ${o}`));
  }

  const raw = await chat(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ]);
  return formatAnswer(qType, raw);
}

async function chat(cfg, messages) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.1,
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`接口返回 ${res.status}：${body || res.statusText}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('接口未返回内容，请检查模型名是否正确');
  return text;
}

/* ---------- 答案解析：把模型的自然语言压成严格格式 ---------- */

function formatAnswer(qType, text) {
  const t = text
    .replace(/^[\s'"「『【（(]*|[\s'"」』】）)]*$/g, '') // 去首尾引号/括号
    .replace(/^(答案|选[项]?|正确答案是)[:：]\s*/i, '')
    .trim();

  if (qType === 'single') {
    const m = t.toUpperCase().match(/[A-H]/);
    return { text: m ? m[0] : t.slice(0, 20), letters: m ? [m[0]] : [] };
  }
  if (qType === 'multi') {
    const letters = [...new Set(t.toUpperCase().match(/[A-H]/g) || [])];
    return { text: letters.join('') || t.slice(0, 60), letters };
  }
  if (qType === 'judge') {
    let answer = '正确';
    if (/错误|不正确|不对|×/.test(t)) answer = '错误';
    else if (/正确|√|对$/.test(t)) answer = '正确';
    return { text: answer, letters: [] };
  }
  // blank / short：直接给文本
  return { text: t.slice(0, 500), letters: [] };
}
