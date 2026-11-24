/* ============================================================
 * 智慧树刷题助手 · 内容脚本
 *  - 在课程页 / 考试页里检测题目块（支持 iframe，all_frames）
 *  - 右上角浮窗列出题目，经 background 调用大模型给出参考答案
 *  - 仅提示答案 + 高亮对应选项，不自动作答
 * ============================================================ */
(() => {
  'use strict';
  const TAG = '[智慧树助手]';
  const PANEL_ID = 'zhxs-panel';
  const LETTERS = 'ABCDEFGH';

  /* 智慧树题目容器的候选选择器（不同页面 / 版本结构不同，命中即停）。
   * 如果识别不到题目：F12 → 右键题目块 → Copy outerHTML，
   * 根据真实 class 名往这个列表里补充。 */
  const KNOWN_SELECTORS = [
    '.subject-item',
    '.question_item',
    '.QesBox',
    '[class*="subject-item"]',
    '[class*="question_item"]',
    '[class*="questionItem"]',
    '[class*="exam-question"]',
    '[class*="question-item"]',
  ];

  let enabled = true;
  let observer = null;
  let panel = null, listEl = null, statusEl = null;
  let rescanTimer = null;
  let seq = 0;

  const items = new Map();   // 题目元素 -> { q, stemEl, answerEl, ... }
  const cache = new Map();   // 题干hash -> 答案对象（本次会话去重，避免重复调用接口）
  const inFlight = new Set();

  /* ---------------- 开关（popup 可控制） ---------------- */
  chrome.storage.sync.get({ enabled: true }, ({ enabled: v }) => {
    enabled = v;
    enabled ? boot() : teardown();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      enabled ? boot() : teardown();
    }
  });

  function boot() {
    if (panel) return;
    observePage();
    scheduleRescan(300);
  }

  function teardown() {
    observer?.disconnect();
    observer = null;
    panel?.remove();
    panel = null;
    rescanTimer && clearTimeout(rescanTimer);
  }

  /* ================= 页面监听 ================= */

  function observePage() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleRescan(800));
    const target = document.body || document.documentElement;
    observer.observe(target, { childList: true, subtree: true });
  }

  function scheduleRescan(delay = 800) {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(scan, delay);
  }

  /* ================= 题目检测 ================= */

  function scan() {
    if (!enabled) return;
    const blocks = findQuestionBlocks();
    if (!blocks.length) return;
    ensurePanel();
    for (const el of blocks) {
      if (items.has(el)) continue;
      const q = parseQuestion(el);
      if (!q) continue;
      const item = createItem(el, q);
      items.set(el, item);
      askLLM(item, q);
      console.info(`${TAG} 识别第 ${q.seq} 题 [${q.type}]`, q.stem);
    }
    updateStatus();
  }

  function findQuestionBlocks() {
    // 1) 已知选择器（按优先级，命中一组就用它，避免外层容器重复匹配）
    const found = [];
    for (const sel of KNOWN_SELECTORS) {
      const els = [...document.querySelectorAll(sel)].filter(isVisible);
      if (els.length) {
        found.push(...els.filter((el) => (el.innerText || '').trim().length >= 8));
        if (found.length) break;
      }
    }
    // 2) 兜底：启发式扫描（选项行正则），仅在已知选择器全部落空时启用
    if (!found.length) found.push(...heuristicScan());
    // 只保留最内层，去掉互相嵌套的容器
    return found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
  }

  function heuristicScan() {
    const out = [];
    const reOpt = /(?:^|\s|>)[A-Ha-h][.、．:：]\s*\S/g;
    for (const el of document.querySelectorAll('div, li, td, dd')) {
      if (!isVisible(el)) continue;
      const t = el.textContent || '';
      if (t.length < 15 || t.length > 1500) continue;
      const optCount = (t.match(reOpt) || []).length;
      const radioCount = el.querySelectorAll('input[type="radio"]').length;
      const isJudge =
        /判断题/.test(t) ||
        (radioCount === 2 && /对|错|正确|错误/.test(t));
      if (optCount >= 2 || isJudge) out.push(el);
      if (out.length >= 30) break;
    }
    return out;
  }

  /* ================= 题目解析 ================= */

  function parseQuestion(el) {
    try {
      const fullText = (el.innerText || '').trim();
      if (fullText.length < 8) return null;

      const radios = [...el.querySelectorAll('input[type="radio"]')];
      const checks = [...el.querySelectorAll('input[type="checkbox"]')];
      const texts = [...el.querySelectorAll('textarea, input[type="text"]')];

      let qType = null;
      let controlEls = [];

      if (checks.length >= 2) {
        qType = 'multi';
        controlEls = checks;
      } else if (radios.length >= 2) {
        const labels = radios.map((r) => optionLabelOf(r));
        const isJudge =
          radios.length === 2 && labels.some((t) => /对|错|正确|错误/.test(t));
        qType = isJudge ? 'judge' : 'single';
        controlEls = radios;
      } else if (texts.length) {
        qType = /简答|论述|谈谈你的|如何理解/.test(fullText) ? 'short' : 'blank';
      } else {
        // 页面用纯文本渲染选项（无 input 控件）
        const optLines = fullText
          .split('\n')
          .filter((l) => /^\s*[A-Ha-h][.、．:：]/.test(l.trim()));
        if (optLines.length >= 2) qType = /多选/.test(fullText) ? 'multi' : 'single';
        else if (/判断题/.test(fullText)) qType = 'judge';
        else return null;
      }

      const options = controlEls.map((inp, i) => ({
        letter: LETTERS[i],
        text: cleanOptionText(optionLabelOf(inp), i),
        el: inp.closest('label') || inp.parentElement || inp,
      }));

      const stem = extractStem(el, options, fullText);
      if (!stem) return null;

      return { seq: ++seq, type: qType, stem, options };
    } catch (e) {
      console.warn(TAG, '解析题目块失败', e);
      return null;
    }
  }

  function optionLabelOf(input) {
    const wrap = input.closest('label') || input.parentElement;
    return (wrap?.innerText || input.value || '').trim();
  }

  function cleanOptionText(text, index) {
    let t = (text || '').replace(/\s+/g, ' ').trim();
    // 去掉自带的字母前缀，也去掉按序号可能误带的前缀
    t = t.replace(new RegExp(`^${LETTERS[index]}\\s*[.、．:：]\\s*`), '');
    return t.slice(0, 200);
  }

  function extractStem(el, options, fullText) {
    // 优先取带 title/stem/subject 类名的子元素
    const titled = el.querySelector('[class*="title"], [class*="stem"], [class*="subject"]');
    if (titled) {
      const t = (titled.innerText || '').trim();
      if (t.length >= 4 && !/^[A-H][.、．:：]/.test(t)) return t.slice(0, 500);
    }
    // 兜底：整块文本去掉选项行 / 题型标记 / 分值行后拼接
    const optSet = new Set(options.map((o) => norm(o.text)).filter(Boolean));
    const stemLines = fullText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        if (/^\(?[（]?\s*(单选题|多选题|判断题|填空题|简答题|单选|多选|判断)/.test(l)) return false;
        if (/^\d+(\.\d+)?\s*分$/.test(l)) return false;
        if (/^[A-Ha-h][.、．:：]/.test(l)) return false;
        if (optSet.has(norm(l))) return false;
        return true;
      });
    const stem = stemLines
      .join(' ')
      .replace(/^\s*\d+\s*[.、．:：]\s*/, '') // 去题号
      .trim();
    return stem.slice(0, 500) || null;
  }

  const norm = (s) =>
    (s || '').replace(/\s+/g, '').replace(/^\d+[.、．:：]\s*/, '');

  function isVisible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }

  function hash(str) {
    let h = 5381;
    for (const c of str) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
    return h.toString(36);
  }

  /* ================= 大模型问答 ================= */

  async function askLLM(item, q) {
    const key = hash(norm(q.stem) + '|' + q.type);
    item.cacheKey = key;
    if (cache.has(key)) return renderAnswer(item, cache.get(key));
    if (inFlight.has(key)) return;
    inFlight.add(key);
    item.answerEl.textContent = '答案请求中…';
    item.answerEl.classList.remove('zhxs-err');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'zhxs-ask',
        payload: { qType: q.type, stem: q.stem, options: q.options.map((o) => o.text) },
      });
      if (!res || !res.ok) throw new Error(res?.error || '未知错误');
      cache.set(key, res.answer);
      renderAnswer(item, res.answer);
    } catch (e) {
      item.answerEl.textContent = '⚠ ' + (e?.message || e);
      item.answerEl.classList.add('zhxs-err');
    } finally {
      inFlight.delete(key);
    }
  }

  function renderAnswer(item, ans) {
    if (!item.answerEl || !document.contains(item.el)) return;
    item.answerEl.textContent = `参考答案：${ans.text}`;
    item.answerEl.classList.remove('zhxs-err');
    highlight(item.q, ans);
  }

  function highlight(q, ans) {
    if (ans.letters?.length) {
      q.options.forEach((o, i) => {
        if (ans.letters.includes(o.letter) || ans.letters.includes(LETTERS[i])) {
          o.el?.classList?.add('zhxs-hit');
        }
      });
      return;
    }
    // 判断题：按文字匹配高亮
    if (q.type === 'judge' && q.options.length === 2) {
      const want = ans.text === '错误' ? /错误|不对|×|^错$/ : /正确|√|^对$/;
      q.options.forEach((o) => {
        if (want.test(o.text)) o.el?.classList?.add('zhxs-hit');
      });
    }
  }

  /* ================= 浮窗 UI ================= */

  function ensurePanel() {
    if (panel || !document.documentElement) return;
    panel = document.createElement('div');
    panel.id = PANEL_ID;

    const head = document.createElement('div');
    head.className = 'zhxs-head';
    const title = document.createElement('span');
    title.className = 'zhxs-title';
    title.textContent = '📌 智慧树助手';

    const btnRe = document.createElement('button');
    btnRe.textContent = '⟳ 重扫';
    btnRe.title = '重新扫描本页题目';
    btnRe.addEventListener('click', () => {
      items.clear();
      listEl.textContent = '';
      scheduleRescan(0);
    });

    const btnMin = document.createElement('button');
    btnMin.textContent = '—';
    btnMin.title = '收起 / 展开';
    btnMin.addEventListener('click', () => {
      panel.classList.toggle('zhxs-min');
      btnMin.textContent = panel.classList.contains('zhxs-min') ? '□' : '—';
    });

    head.append(title, btnRe, btnMin);
    makeDraggable(panel, head);

    statusEl = document.createElement('div');
    statusEl.className = 'zhxs-status';
    statusEl.textContent = '正在扫描页面题目…';

    listEl = document.createElement('div');
    listEl.className = 'zhxs-list';

    panel.append(head, statusEl, listEl);
    document.documentElement.appendChild(panel);
  }

  function createItem(el, q) {
    const box = document.createElement('div');
    box.className = 'zhxs-item';

    const stem = document.createElement('div');
    stem.className = 'zhxs-stem';
    const typeName = { single: '单选', multi: '多选', judge: '判断', blank: '填空', short: '简答' }[q.type] || q.type;
    stem.textContent = `${q.seq}. [${typeName}] ${q.stem}`;

    const answer = document.createElement('div');
    answer.className = 'zhxs-answer';
    answer.textContent = '…';

    box.append(stem, answer);
    listEl.appendChild(box);
    return { el, q, stemEl: stem, answerEl: answer, cacheKey: null };
  }

  function updateStatus() {
    if (!statusEl) return;
    const n = items.size;
    statusEl.textContent = n ? `已识别 ${n} 道题，答案仅供参考，请自行核对` : '本页暂未识别到题目';
  }

  function makeDraggable(box, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = box.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      const move = (ev) => {
        box.style.left = Math.max(0, ev.clientX - dx) + 'px';
        box.style.top = Math.max(0, ev.clientY - dy) + 'px';
        box.style.right = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }
})();
