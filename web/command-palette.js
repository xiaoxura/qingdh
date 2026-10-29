/* ==========================================================================
 * 氢导航 · 命令面板（Ctrl/⌘ + K）
 *
 * 键盘直达：搜索、问 AI、新建/打开备忘录、打开隐私空间、设置与主题。
 * 隐私内容不进入索引，只保留“打开隐私空间”；锁定状态下不索引备忘录。
 * ========================================================================== */

(() => {
  'use strict';

  const RESULT_GROUPS = [
    { kind: 'memo', label: '备忘录', limit: 3 },
    { kind: 'group', label: '分组', limit: 2 },
    { kind: 'link', label: '快捷方式', limit: 4 },
    { kind: 'search', label: '搜索操作', limit: 2 },
    { kind: 'action', label: '操作', limit: 8 },
  ];

  const deps = {
    escapeHTML: (value) => String(value),
    engineName: () => '默认搜索引擎',
    aiProviderName: () => '',
    searchWeb: (query) => {},
    askAI: (query) => {},
    newMemo: () => {},
    openMemo: () => {},
    openMemoById: (id) => {},
    openPrivacy: () => {},
    openSettings: () => {},
    openAccount: () => {},
    toggleTheme: () => {},
    toggleEdit: () => {},
    exportData: () => {},
    navigateURL: (url) => {},
    getLinks: () => [],
    getGroups: () => [],
    openGroup: (id) => {},
    getMemoTitles: () => [],
    getMemos: () => [],
    closeMemo: () => {},
  };

  const state = {
    open: false,
    items: [],
    activeIndex: 0,
  };

  let dom = null;
  const suggestions = { items: [], activeIndex: -1 };

  function $(id) {
    return document.getElementById(id);
  }

  function init(nextDeps) {
    if (nextDeps) Object.assign(deps, nextDeps);

    dom = {
      dialog: $('command-dialog'),
      input: $('command-input'),
      list: $('command-list'),
      searchForm: $('search-form'),
      searchInput: $('search-input'),
    };
    initSuggestions();
    if (!dom.dialog) return;

    dom.input.addEventListener('input', (event) => {
      if (!event.isComposing) render();
    });
    dom.input.addEventListener('compositionend', render);
    dom.input.addEventListener('keydown', onKeydown);
    dom.list.addEventListener('click', (event) => {
      const option = event.target.closest('[data-command-index]');
      if (!option) return;
      run(Number(option.dataset.commandIndex));
    });
    dom.list.addEventListener('mousemove', (event) => {
      const option = event.target.closest('[data-command-index]');
      if (!option) return;
      const index = Number(option.dataset.commandIndex);
      if (index !== state.activeIndex) setActive(index);
    });
    dom.dialog.addEventListener('close', () => {
      state.open = false;
      state.items = [];
      dom.list.replaceChildren();
      dom.input.value = '';
    });
  }

  function open() {
    if (!dom || dom.dialog.open) return;
    state.open = true;
    dom.input.value = '';
    dom.dialog.showModal();
    render();
    setTimeout(() => dom.input.focus(), 30);
  }

  function close() {
    if (dom && dom.dialog.open) dom.dialog.close();
  }

  /* ------------------------------------------------------------------ *
   * 结果
   * ------------------------------------------------------------------ */

  function buildItems(query) {
    const trimmed = query.trim();
    const lower = trimmed.toLowerCase();
    const items = [];

    if (trimmed) {
      items.push({
        id: 'search-web',
        kind: 'search',
        label: `用 ${deps.engineName()} 搜索「${trimmed}」`,
        hint: '网页',
        icon: 'search',
        run: () => deps.searchWeb(trimmed),
      });

      const aiName = deps.aiProviderName();
      if (aiName) {
        items.push({
          id: 'ask-ai',
          kind: 'search',
          label: `问 AI（${aiName}）`,
          hint: trimmed,
          icon: 'ai',
          run: () => deps.askAI(trimmed),
        });
      } else {
        items.push({
          id: 'ask-ai-enable',
          kind: 'search',
          label: '开启 AI 搜索…',
          hint: 'AI',
          icon: 'ai',
          run: () => deps.openSettings(),
        });
      }
    }

    const actions = [
      { id: 'new-memo', label: '新建备忘录', hint: 'Ctrl+Shift+M', icon: 'memo', run: () => deps.newMemo() },
      { id: 'open-memo', label: '打开备忘录', hint: '', icon: 'memo', run: () => deps.openMemo() },
      { id: 'open-privacy', label: '打开隐私空间', hint: '快捷键', icon: 'lock', run: () => deps.openPrivacy() },
      { id: 'open-settings', label: '打开设置', hint: '', icon: 'settings', run: () => deps.openSettings() },
      { id: 'toggle-theme', label: '切换明暗主题', hint: '', icon: 'theme', run: () => deps.toggleTheme() },
      { id: 'toggle-edit', label: '切换编辑模式', hint: '', icon: 'edit', run: () => deps.toggleEdit() },
      { id: 'export-data', label: '导出数据', hint: '', icon: 'download', run: () => deps.exportData() },
      { id: 'open-account', label: '账号与同步', hint: '', icon: 'account', run: () => deps.openAccount() },
    ];

    for (const action of actions) {
      if (!lower || fuzzy(action.label, lower)) items.push({ ...action, kind: 'action' });
    }

    if (trimmed) {
      const memos = deps.getMemos();
      for (const memo of memos.length ? memos : deps.getMemoTitles()) {
        if (!memo || !memo.id) continue;
        const title = memo.title || '无标题';
        const body = String(memo.body || '');
        const bodyLower = memo.bodyLower != null ? String(memo.bodyLower) : body.toLowerCase();
        const tags = Array.isArray(memo.tags) ? memo.tags.join(' ') : '';
        const haystack = memo.search != null ? String(memo.search) : `${title}\n${body}\n${tags}`.toLowerCase();
        if (lower && !fuzzyLower(haystack, lower)) continue;
        let snippet = '备忘录';
        if (body && lower) {
          const at = bodyLower.indexOf(lower);
          if (at >= 0) {
            const start = Math.max(0, at - 24);
            snippet = `${start > 0 ? '…' : ''}${body.slice(start, at + 70).replace(/\s+/g, ' ')}${
              at + 70 < body.length ? '…' : ''
            }`;
          } else if (tags && tags.toLowerCase().includes(lower)) {
            snippet = `标签：${tags}`;
          }
        }
        items.push({
          id: `memo-${memo.id}`,
          kind: 'memo',
          label: title,
          hint: snippet,
          icon: 'memo',
          run: () => deps.openMemoById(memo.id),
        });
      }

      for (const group of deps.getGroups()) {
        if (!group || !group.name) continue;
        if (lower && fuzzy(group.name, lower)) {
          items.push({
            id: `group-${group.id}`,
            kind: 'group',
            label: group.name,
            hint: '分组',
            icon: 'group',
            run: () => deps.openGroup(group.id),
          });
        }
      }

      for (const link of deps.getLinks()) {
        if (!link || !link.url) continue;
        const label = link.title || link.url;
        if (lower && (fuzzy(label, lower) || fuzzy(link.url, lower))) {
          items.push({
            id: `link-${link.id}`,
            kind: 'link',
            label,
            hint: hostOf(link.url),
            icon: 'link',
            run: () => deps.navigateURL(link.url),
          });
        }
      }
    }

    return RESULT_GROUPS.flatMap((group) =>
      items.filter((item) => item.kind === group.kind).slice(0, group.limit)
    );
  }

  function initSuggestions() {
    if (!dom.searchForm || !dom.searchInput) return;
    const list = document.createElement('div');
    list.id = 'search-suggestions';
    list.className = 'search-suggestions';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '搜索建议');
    list.hidden = true;
    dom.searchForm.appendChild(list);
    dom.suggestions = list;

    dom.searchInput.setAttribute('role', 'combobox');
    dom.searchInput.setAttribute('aria-autocomplete', 'list');
    dom.searchInput.setAttribute('aria-controls', list.id);
    dom.searchInput.setAttribute('aria-expanded', 'false');

    dom.searchInput.addEventListener('input', (event) => {
      if (!event.isComposing) scheduleSuggestions();
    });
    dom.searchInput.addEventListener('focus', renderSuggestions);
    dom.searchInput.addEventListener('compositionstart', hideSuggestions);
    dom.searchInput.addEventListener('compositionend', renderSuggestions);
    dom.searchInput.addEventListener('keydown', onSuggestionKeydown, true);
    dom.searchInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement !== dom.searchInput) hideSuggestions();
      }, 0);
    });
    list.addEventListener('click', (event) => {
      const option = event.target.closest('[data-search-index]');
      if (!option || !list.contains(option)) return;
      runSuggestion(Number(option.dataset.searchIndex));
    });
    list.addEventListener('mousedown', (event) => {
      if (event.target.closest('[data-search-index]')) event.preventDefault();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!dom.searchForm.contains(event.target)) hideSuggestions();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hideSuggestions();
    });
    window.addEventListener('pagehide', hideSuggestions);
  }

  let suggestionTimer = 0;

  function scheduleSuggestions() {
    clearTimeout(suggestionTimer);
    suggestionTimer = setTimeout(renderSuggestions, 120);
  }

  function renderSuggestions() {
    clearTimeout(suggestionTimer);
    suggestionTimer = 0;
    if (!dom?.suggestions || !dom.searchInput.value.trim()) {
      hideSuggestions();
      return;
    }

    const matches = buildItems(dom.searchInput.value);
    const groups = RESULT_GROUPS.filter((group) => group.kind !== 'action').map((group) => ({
      ...group,
      items: matches.filter((item) => item.kind === group.kind).slice(0, group.limit),
    })).filter((group) => group.items.length);

    suggestions.items = groups.flatMap((group) => group.items);
    suggestions.activeIndex = -1;
    dom.suggestions.innerHTML = groups.map((group) => {
      const options = group.items.map((item) => {
        const index = suggestions.items.indexOf(item);
        return `<div class="search-suggestion" role="option" id="search-suggestion-${index}" aria-selected="false" data-search-index="${index}">
          ${iconMarkup(item.icon)}
          <span class="search-suggestion-label">${deps.escapeHTML(item.label)}</span>
          ${item.hint ? `<span class="search-suggestion-hint">${deps.escapeHTML(item.hint)}</span>` : ''}
        </div>`;
      }).join('');
      return `<div class="search-suggestion-group" role="group" aria-label="${group.label}">
        <div class="search-suggestion-heading" aria-hidden="true">${group.label}</div>${options}
      </div>`;
    }).join('');
    dom.suggestions.hidden = !suggestions.items.length;
    dom.searchInput.setAttribute('aria-expanded', String(Boolean(suggestions.items.length)));
    dom.searchInput.removeAttribute('aria-activedescendant');
  }

  function hideSuggestions() {
    clearTimeout(suggestionTimer);
    suggestionTimer = 0;
    suggestions.items = [];
    suggestions.activeIndex = -1;
    if (!dom?.suggestions) return;
    dom.suggestions.hidden = true;
    dom.suggestions.replaceChildren();
    dom.searchInput.setAttribute('aria-expanded', 'false');
    dom.searchInput.removeAttribute('aria-activedescendant');
  }

  function clearSuggestions() {
    hideSuggestions();
    if (!dom?.list) return;
    state.items = [];
    dom.list.replaceChildren();
    if (dom.dialog?.open) close();
  }

  function setSuggestionActive(index) {
    if (!suggestions.items.length) return;
    const count = suggestions.items.length;
    suggestions.activeIndex = (index + count) % count;
    dom.suggestions.querySelectorAll('[data-search-index]').forEach((option, i) => {
      const active = i === suggestions.activeIndex;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', String(active));
    });
    const option = $(`search-suggestion-${suggestions.activeIndex}`);
    dom.searchInput.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  }

  function onSuggestionKeydown(event) {
    if (event.isComposing || event.keyCode === 229 || !dom.suggestions || dom.suggestions.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSuggestionActive(suggestions.activeIndex < 0 ? (step > 0 ? 0 : suggestions.items.length - 1) : suggestions.activeIndex + step);
    } else if (event.key === 'Enter' && suggestions.activeIndex >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      runSuggestion(suggestions.activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      hideSuggestions();
    }
  }

  function runSuggestion(index) {
    const item = suggestions.items[index];
    if (!item) return;
    hideSuggestions();
    item.run();
  }

  function fuzzy(text, query) {
    return fuzzyLower(String(text || '').toLowerCase(), query);
  }

  function fuzzyLower(source, query) {
    let index = 0;
    for (const char of query) {
      index = source.indexOf(char, index);
      if (index === -1) return false;
      index += 1;
    }
    return true;
  }

  function hostOf(url) {
    if (globalThis.QingdhCore) return QingdhCore.hostOf(url);
    try {
      return new URL(url).host;
    } catch (error) {
      return '';
    }
  }

  function iconMarkup(name) {
    const paths = {
      search:
        '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
      ai: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
      memo: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>',
      lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      settings:
        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/>',
      theme: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
      edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
      download: '<path d="M12 3v12M7 11l5 5 5-5"/><path d="M5 21h14"/>',
      account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
      group: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    };
    return `<svg class="command-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
      paths[name] || paths.search
    }</svg>`;
  }

  function render() {
    state.items = buildItems(dom.input.value);
    state.activeIndex = Math.min(state.activeIndex, Math.max(0, state.items.length - 1));

    if (!state.items.length) {
      dom.list.innerHTML = '<p class="command-empty">没有匹配的结果</p>';
      dom.input.removeAttribute('aria-activedescendant');
      return;
    }

    dom.list.innerHTML = state.items
      .map(
        (item, index) => `<button class="command-option${index === state.activeIndex ? ' is-active' : ''}" type="button" role="option" id="command-option-${index}" aria-selected="${
          index === state.activeIndex
        }" data-command-index="${index}">
          ${iconMarkup(item.icon)}
          <span class="command-label">${deps.escapeHTML(item.label)}</span>
          ${item.hint ? `<span class="command-sub">${deps.escapeHTML(item.hint)}</span>` : ''}
        </button>`
      )
      .join('');
    dom.input.setAttribute('aria-activedescendant', `command-option-${state.activeIndex}`);
    dom.list.querySelector('.command-option.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function setActive(index) {
    if (!state.items.length) return;
    state.activeIndex = (index + state.items.length) % state.items.length;
    Array.from(dom.list.querySelectorAll('.command-option')).forEach((option, i) => {
      const active = i === state.activeIndex;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', String(active));
    });
    dom.input.setAttribute('aria-activedescendant', `command-option-${state.activeIndex}`);
    dom.list.querySelector('.command-option.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(state.activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(state.activeIndex - 1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      setActive(state.activeIndex + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(state.activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  function run(index) {
    const item = state.items[index];
    if (!item) return;
    close();
    setTimeout(() => {
      try {
        item.run();
      } catch (error) {
        // 动作失败不应让面板留在半关闭状态。
      }
    }, 0);
  }

  globalThis.QingdhCommandPalette = {
    init,
    open,
    close,
    clearSuggestions,
    isOpen: () => Boolean(dom && dom.dialog.open),
  };
})();
