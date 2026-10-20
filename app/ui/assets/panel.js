import { hana } from './sdk.js';

const statusEl = document.getElementById('status');
const listEl = document.getElementById('providers');

const state = {
  providers: [],
  providerId: '',
  curlAvailable: false,
};

let saveTimer = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function newProviderId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function field(labelText, input) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.append(label, input);
  return wrap;
}

function textInput(value, placeholder, onInput) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function guessType(id) {
  return /video/i.test(id || '') ? 'video' : 'image';
}

function guessSize(id, type) {
  if ((type || guessType(id)) === 'video') return '720P';
  return /^agnes-image/i.test(id || '') ? '1K' : '1024x1024';
}

function sizeCandidates(id, type) {
  if ((type || guessType(id)) === 'video') return ['720P', '1080P'];
  if (/^agnes-image/i.test(id || '')) return ['1K', '2K', '3K', '4K'];
  return ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'];
}

function modelRow(provider, model) {
  const wrap = document.createElement('div');
  wrap.className = 'model-block';

  const row = document.createElement('div');
  row.className = 'model-row';

  const id = textInput(model.id, '模型 ID，如 agnes-image-2.5-flash 或 agnes-video-2.5-flash', (value) => {
    model.id = value.trim();
    if (!model.type) model.type = guessType(model.id);
    if (!model.size) sizeInput.value = guessSize(model.id, model.type);
  });
  const name = textInput(model.name, '显示名（可留空）', (value) => {
    model.name = value.trim();
  });

  const typeSelect = document.createElement('select');
  typeSelect.className = 'model-type';
  for (const [value, label] of [
    ['image', '图片'],
    ['video', '视频'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if ((model.type || guessType(model.id)) === value) option.selected = true;
    typeSelect.appendChild(option);
  }
  typeSelect.addEventListener('change', () => {
    model.type = typeSelect.value;
    model.size = guessSize(model.id, model.type);
    render();
  });

  const duration = textInput(model.seconds || '5', '视频时长（秒，4-12）', (value) => {
    model.seconds = value.trim();
  });

  const listId = `sizes-${Math.random().toString(36).slice(2, 8)}`;
  const sizeInput = document.createElement('input');
  sizeInput.type = 'text';
  sizeInput.className = 'model-size';
  sizeInput.value = model.size || guessSize(model.id, model.type || guessType(model.id));
  sizeInput.placeholder = '尺寸';
  sizeInput.setAttribute('list', listId);
  sizeInput.addEventListener('input', () => {
    model.size = sizeInput.value.trim();
  });
  const dataList = document.createElement('datalist');
  dataList.id = listId;
  for (const value of sizeCandidates(model.id, model.type || guessType(model.id))) {
    const option = document.createElement('option');
    option.value = value;
    dataList.appendChild(option);
  }

  const ratio = document.createElement('select');
  ratio.className = 'model-ratio';
  const ratioOptions = [
    ['', '宽高比：默认'],
    ['1:1', '1:1'],
    ['3:2', '3:2'],
    ['2:3', '2:3'],
    ['16:9', '16:9'],
    ['9:16', '9:16'],
    ['4:3', '4:3'],
    ['3:4', '3:4'],
    ['21:9', '21:9'],
  ];
  for (const [value, label] of ratioOptions) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if ((model.ratio || '') === value) option.selected = true;
    ratio.appendChild(option);
  }
  ratio.addEventListener('change', () => {
    model.ratio = ratio.value;
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link-btn';
  remove.textContent = '删除';
  remove.addEventListener('click', () => {
    provider.models = provider.models.filter((item) => item !== model);
    render();
  });

  row.append(id, typeSelect, sizeInput, ratio, remove, dataList);

  const details = document.createElement('details');
  details.className = 'model-extra';
  const summary = document.createElement('summary');
  summary.textContent = '高级：额外参数（可选）';
  const extra = textInput(
    model._extraText !== undefined ? model._extraText : model.extra ? JSON.stringify(model.extra) : '',
    '例如 {"extra_body":{"response_format":"url"}}',
    (value) => {
      model._extraText = value;
    },
  );
  details.append(summary, name, duration, extra);

  wrap.append(row, details);
  return wrap;
}

function providerBlock(provider) {
  const wrap = document.createElement('div');
  wrap.className = 'provider';

  const head = document.createElement('div');
  head.className = 'provider-head';
  const title = document.createElement('span');
  title.className = 'provider-title';
  title.textContent = provider.name || provider.id || '未命名供应商';
  const removeProvider = document.createElement('button');
  removeProvider.type = 'button';
  removeProvider.className = 'btn danger';
  removeProvider.textContent = '移除供应商';
  removeProvider.addEventListener('click', () => {
    state.providers = state.providers.filter((item) => item !== provider);
    render();
  });
  head.append(title, removeProvider);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.append(
    field(
      '供应商名称',
      textInput(provider.name, '例如：我的中转', (value) => {
        provider.name = value.trim();
        title.textContent = provider.name || provider.id;
      }),
    ),
    field(
      'Base URL',
      textInput(provider.baseUrl, 'https://example.com/v1', (value) => {
        provider.baseUrl = value.trim();
      }),
    ),
    field(
      'API Key',
      (() => {
        const input = document.createElement('input');
        input.type = 'password';
        input.value = provider.apiKey || '';
        input.placeholder = 'sk-...';
        input.autocomplete = 'off';
        input.addEventListener('input', () => {
          provider.apiKey = input.value.trim();
        });
        return input;
      })(),
    ),
  );

  const models = document.createElement('div');
  models.className = 'models';
  const modelsHead = document.createElement('div');
  modelsHead.className = 'models-head';
  const modelsTitle = document.createElement('span');
  modelsTitle.className = 'models-title';
  modelsTitle.textContent = `模型（${provider.models.length}）`;
  const addModel = document.createElement('button');
  addModel.type = 'button';
  addModel.className = 'link-btn';
  addModel.textContent = '添加模型';
  addModel.addEventListener('click', () => {
    provider.models.push({ id: '', name: '', sizes: [], defaultSize: '' });
    render();
  });
  modelsHead.append(modelsTitle, addModel);
  models.appendChild(modelsHead);

  if (!provider.models.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '还没有模型。点「添加模型」填一个服务端真实的模型名。';
    models.appendChild(empty);
  } else {
    for (const model of provider.models) models.appendChild(modelRow(provider, model));
  }

  wrap.append(head, grid, models);
  return wrap;
}

function render() {
  listEl.textContent = '';
  if (!state.providers.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有供应商。点右上角「添加供应商」，填 Base URL、API Key 和至少一个模型。';
    listEl.appendChild(empty);
    return;
  }
  for (const provider of state.providers) listEl.appendChild(providerBlock(provider));
}

function parseExtra(model) {
  const text = typeof model._extraText === 'string' ? model._extraText.trim() : '';
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`模型「${model.id || model.name || '未命名'}」的额外参数不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`模型「${model.id || model.name || '未命名'}」的额外参数必须是 JSON 对象`);
  }
  return parsed;
}

function payload() {
  return {
    providers: state.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      models: provider.models
        .filter((model) => model.id)
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          type: model.type || guessType(model.id),
          size: model.size || guessSize(model.id, model.type),
          ratio: model.ratio || '',
          seconds: model.seconds || '5',
          extra: parseExtra(model),
        })),
    })),
  };
}

async function load() {
  setStatus('正在读取配置…');
  try {
    const response = await hana.api.fetch('config');
    if (!response.ok) throw new Error(`读取配置失败：HTTP ${response.status}`);
    const data = await response.json();
    state.providers = Array.isArray(data.providers) ? data.providers : [];
    state.providerId = data.providerId || '';
    state.curlAvailable = Boolean(data.curlAvailable);
    render();
    setStatus(
      state.curlAvailable
        ? `已连接。自定义供应商 id：${state.providerId}`
        : 'curl 不可用：请先在设置的应用能力里授予「运行外部命令」，并重新加载 App。',
      state.curlAvailable ? 'ok' : 'bad',
    );
  } catch (error) {
    setStatus(String(error?.message || error), 'bad');
  }
}

async function save() {
  const data = payload();
  for (const provider of data.providers) {
    if (!provider.baseUrl) {
      setStatus(`供应商「${provider.name || provider.id}」缺少 Base URL`, 'bad');
      return;
    }
    if (!provider.models.length) {
      setStatus(`供应商「${provider.name || provider.id}」还没有模型`, 'bad');
      return;
    }
  }
  setStatus('正在保存…');
  try {
    const response = await hana.api.fetch('config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`保存失败：HTTP ${response.status}`);
    const saved = await response.json();
    state.providers = Array.isArray(saved.providers) ? saved.providers : state.providers;
    render();
    if (Array.isArray(saved.syncErrors) && saved.syncErrors.length) {
      setStatus(`已保存，但有 ${saved.syncErrors.length} 个模型没写进宿主：${saved.syncErrors.join('；')}`, 'bad');
      return;
    }
    setStatus('已保存。到「多媒体 → 图片生成」里选择供应商「模型桥（自定义）」。', 'ok');
  } catch (error) {
    setStatus(String(error?.message || error), 'bad');
  }
}

document.getElementById('add-provider').addEventListener('click', () => {
  state.providers.push({
    id: newProviderId(),
    name: '',
    baseUrl: '',
    apiKey: '',
    models: [{ id: '', name: '', sizes: [], defaultSize: '' }],
  });
  render();
});

document.getElementById('save').addEventListener('click', () => {
  clearTimeout(saveTimer);
  save();
});

await hana.ready();

// 防止页面在首次渲染前空白
render();
load();
