/* 智慧树刷题助手 · 设置弹窗逻辑 */

const DEFAULTS = {
  enabled: true,
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4-flash',
};

const $ = (id) => document.getElementById(id);
const msg = $('msg');

function setMsg(text, ok) {
  msg.textContent = text;
  msg.className = ok ? 'ok' : 'err';
}

async function init() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  $('enabled').checked = cfg.enabled;
  $('baseUrl').value = cfg.baseUrl;
  $('model').value = cfg.model;
  $('apiKey').value = cfg.apiKey;
}

$('save').addEventListener('click', async () => {
  const baseUrl = $('baseUrl').value.trim() || DEFAULTS.baseUrl;
  const model = $('model').value.trim() || DEFAULTS.model;
  const apiKey = $('apiKey').value.trim();
  const enabled = $('enabled').checked;
  await chrome.storage.sync.set({ baseUrl, model, apiKey, enabled });
  setMsg(apiKey ? '✓ 已保存' : '已保存，但还没填 API Key', !!apiKey);
});

$('test').addEventListener('click', async () => {
  setMsg('测试中…');
  // 先把当前表单存进去再测
  await chrome.storage.sync.set({
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    model: $('model').value.trim() || DEFAULTS.model,
    apiKey: $('apiKey').value.trim(),
    enabled: $('enabled').checked,
  });
  try {
    const res = await chrome.runtime.sendMessage({ type: 'zhxs-test' });
    if (res?.ok) setMsg(`✓ 连接成功，模型已响应：${res.raw.slice(0, 50)}`, true);
    else setMsg(`✗ ${res?.error || '未知错误'}`, false);
  } catch (e) {
    setMsg(`✗ ${e?.message || e}`, false);
  }
});

init();
