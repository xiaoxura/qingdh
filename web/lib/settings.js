/* ==========================================================================
 * 氢导航 · 设置 Hub 与导入导出
 *
 * 从 app.js 抽出的设置面板、账号入口、备份导出/恢复、JSON 书签导入。
 * 通过 create(deps) 注入状态、DOM 与业务回调，保持零构建 classic script。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(deps) {
    const {
      dom,
      prefs,
      sync,
      state,
      cryptoState,
      $,
      $$,
      MAX_GROUPS,
      MAX_LINKS,
      ENGINES,
      CLOCK_STYLES,
      HOUR_CYCLES,
      ICON_X,
      escapeHTML,
      normalizeData,
      normalizeLink,
      normalizeUrl,
      clone,
      now,
      stampAll,
      countGroups,
      countLinks,
      createDefaultData,
      makeGroup,
      makeLink,
      enforceLimits,
      currentKey,
      formatTime,
      readSnapshot,
      saveSnapshot,
      writeJSON,
      markDirty,
      broadcastChange,
      render,
      renderClock,
      updateSnapshotButton,
      renderEngineSettings,
      syncSettingsSidebarUI,
      renderSyncManager,
      commitLocalChange,
      showToast,
      askConfirm,
      api,
      ensureDialogs,
      withOptionalModule,
      updateAccountUI,
      refreshVaultState,
      refreshPasskeyUI,
      setAuthView,
      authSupported,
      ensureUnlockedForPush,
      syncNow,
      promptDecryptFile,
      setStatus,
      updateSyncUI,
      showAuthError,
      handleAuthLost,
      loadSessions,
      signOutLocally,
      describeAgent,
      getData,
      setData,
    } = deps;

  const HUB_GROUPS = {
    account: 'account',
    appearance: 'appearance',
    search: 'search',
    ai: 'search',
    usage: 'search',
    sync: 'sync',
    data: 'sync',
    privacy: 'privacy',
    encryption: 'privacy',
    device: 'privacy',
    'privacy-space': 'privacy',
  };

  const HUB_PANELS = {
    account: ['account'],
    appearance: ['appearance'],
    search: ['search', 'ai', 'usage'],
    sync: ['sync', 'data'],
    privacy: ['encryption', 'device', 'privacy-space'],
  };

  const HUB_PANEL_LABELS = {
    search: '网页搜索',
    ai: 'AI 配置',
    usage: '调用概览',
    sync: '同步',
    data: '数据管理',
    encryption: '数据加密',
    device: '本机解锁',
    'privacy-space': '隐私空间',
  };

  const HUB_FOOT_NOTES = {
    account: '登录状态与同步会自动更新',
    search: '搜索设置即时保存',
    ai: '修改 AI 配置后点击“保存 AI 配置”',
    usage: '统计来自服务端调用记录',
  };

  function syncSettingsUI() {
    dom.setName.value = getData().settings.name;
    dom.setEngine.value = getData().settings.engine;
    dom.setOpen.value = prefs.openInNewTab ? 'new' : 'same';
    dom.setTheme.value = prefs.theme;

    if (dom.setClock) {
      dom.setClock.value = CLOCK_STYLES.includes(prefs.clockStyle) ? prefs.clockStyle : 'editorial';
      dom.setHour.value = HOUR_CYCLES.includes(prefs.hourCycle) ? prefs.hourCycle : 'auto';
      dom.setSeconds.checked = Boolean(prefs.showSeconds);
      syncSettingsSidebarUI();
    }

    if (globalThis.QingdhSelect) {
      QingdhSelect.sync(dom.setEngine);
      QingdhSelect.sync(dom.setOpen);
      QingdhSelect.sync(dom.setTheme);
      QingdhSelect.sync(dom.setClock);
      QingdhSelect.sync(dom.setHour);
      QingdhSelect.sync(dom.setSidebar);
    }

    $$('input[name="season"]', dom.seasonPicker).forEach((input) => {
      input.checked = input.value === prefs.season;
    });
    renderEngineSettings();
    updateSnapshotButton();
  }

  function renderHubSubnav(group, activePanel) {
    if (!dom.hubSubnav) return;
    const panels = HUB_PANELS[group] || [];
    if (panels.length < 2) {
      dom.hubSubnav.hidden = true;
      dom.hubSubnav.innerHTML = '';
      return;
    }
    const current = Array.from(dom.hubSubnav.querySelectorAll('[data-hub-subtab]')).map(
      (button) => button.dataset.hubSubtab
    );
    if (current.join('|') !== panels.join('|')) {
      dom.hubSubnav.innerHTML = panels
        .map(
          (key) =>
            `<button class="hub-subnav-item" type="button" role="tab" data-hub-subtab="${key}">${escapeHTML(HUB_PANEL_LABELS[key] || key)}</button>`
        )
        .join('');
    }
    dom.hubSubnav.hidden = false;
    dom.hubSubnav.querySelectorAll('[data-hub-subtab]').forEach((button) => {
      const active = button.dataset.hubSubtab === activePanel;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
  }

  function updateAIConfigGate() {
    if (!dom.aiConfigGate) return;
    const eligible = Boolean(sync.user) && cryptoState.enabled;
    dom.aiConfigGate.hidden = eligible;
    if (dom.aiProviderList) dom.aiProviderList.hidden = !eligible;
    if (eligible) return;
    const needLogin = !sync.user;
    if (dom.aiConfigGateTitle) {
      dom.aiConfigGateTitle.textContent = needLogin ? '登录后配置 AI' : '开启数据加密后配置 AI';
    }
    if (dom.aiConfigGateDesc) {
      dom.aiConfigGateDesc.textContent = needLogin
        ? 'AI 供应商与 API Key 需要登录、并开启数据加密后才能保存。'
        : 'AI 配置使用主数据密钥派生的子密钥加密，请先在“安全与隐私 → 数据加密”中开启。';
    }
    if (dom.aiConfigGateAction) {
      dom.aiConfigGateAction.textContent = needLogin ? '去登录' : '去开启数据加密';
    }
  }

  function setHubTab(tab) {
    const group = HUB_GROUPS[tab] || 'account';
    const panels = HUB_PANELS[group];
    const activePanel = panels.includes(tab) ? tab : panels[0];

    dom.hubTabs.forEach((button) => {
      const active = button.dataset.hubTab === group;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    dom.hubPanels.forEach((panel) => {
      panel.hidden = panel.dataset.hubPanel !== activePanel;
    });
    renderHubSubnav(group, activePanel);

    if (dom.hubCategory && dom.hubCategory.value !== group) {
      dom.hubCategory.value = group;
      if (globalThis.QingdhSelect) QingdhSelect.sync(dom.hubCategory);
    }
    const activeButton = dom.hubTabs.find((button) => button.dataset.hubTab === group);
    if (activeButton) {
      dom.hubPanelTitle.textContent = activeButton.dataset.title || activeButton.textContent.trim();
      dom.hubPanelDesc.textContent = activeButton.dataset.desc || '';
    }
    if (dom.hubBody) dom.hubBody.scrollTop = 0;

    if (activeButton && window.matchMedia('(max-width: 860px)').matches) {
      const nav = activeButton.closest('.hub-nav');
      if (nav) {
        requestAnimationFrame(() => {
          nav.scrollTo({
            left: activeButton.offsetLeft - (nav.clientWidth - activeButton.offsetWidth) / 2,
            behavior: 'smooth',
          });
        });
      }
    }

    const aiEligible = Boolean(sync.user) && cryptoState.enabled;
    if (dom.hubFootNote) {
      let note = HUB_FOOT_NOTES[activePanel] || '修改会即时保存';
      if (activePanel === 'ai' && !aiEligible) {
        note = sync.user ? '开启数据加密后可保存 AI 配置' : '登录后可配置 AI';
      }
      dom.hubFootNote.textContent = note;
    }

    const showAISave = activePanel === 'ai' && aiEligible;
    if (dom.aiConfigSave) {
      dom.aiConfigSave.hidden = !showAISave;
      dom.aiConfigSave.classList.toggle('btn-primary', showAISave);
    }
    if (dom.hubDone) dom.hubDone.classList.toggle('btn-primary', !showAISave);

    updateAIConfigGate();

    if (activePanel === 'account') {
      updateAccountUI();
    } else {
      syncSettingsUI();
      if (activePanel === 'device') withOptionalModule('QingdhPasskey', () => refreshPasskeyUI());
      if (activePanel === 'privacy-space') withOptionalModule('QingdhPrivacy', () => QingdhPrivacy.refreshSettings());
      if (activePanel === 'usage') withOptionalModule('QingdhAI', () => QingdhAI.openUsage());
      if (activePanel === 'sync') renderSyncManager();
      if (activePanel === 'ai' && aiEligible) {
        withOptionalModule('QingdhAI', () => {
          if (!QingdhAI.prepareConfig) return;
          QingdhAI.prepareConfig().catch((error) => {
            if (!dom.aiConfigError) return;
            dom.aiConfigError.textContent = (error && error.message) || '读取 AI 配置失败';
            dom.aiConfigError.hidden = false;
          });
        });
      }
    }
  }

  function openHub(tab) {
    ensureDialogs();
    if (!dom.hubDialog.open) dom.hubDialog.showModal();
    setHubTab(tab || 'account');
    requestAnimationFrame(() => dom.hubDialog.focus());
  }

  function openSettings() {
    openHub('appearance');
  }

  function openAIConfig() {
    openHub('ai');
  }

  function openAccountDialog() {
    ensureDialogs();
    if (!authSupported()) {
      showToast('登录需要通过网络访问本页面');
      return;
    }
    updateAccountUI();
    if (!sync.user) setAuthView('login');
    else {
      refreshVaultState();
      withOptionalModule('QingdhPasskey', () => refreshPasskeyUI());
    }
    openHub('account');
  }

  function downloadJSON(payload, suffix = '') {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate()
    ).padStart(2, '0')}`;

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `qingdh-${stamp}${suffix}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportData() {
    if (!cryptoState.enabled) {
      downloadJSON(getData());
      return;
    }

    if (!(await ensureUnlockedForPush())) return;
    await syncNow({ manual: true });

    const response = await api('/api/v1/workspace');
    if (!response.ok) {
      showToast('导出失败：无法读取云端数据');
      return;
    }
    if (!QingdhCrypto.isEncrypted(response.data.payload)) {
      showToast('导出失败：云端数据不是加密状态');
      return;
    }

    downloadJSON(response.data.payload, '-encrypted');
    dom.hubDialog.close();
    showToast('已导出加密备份，需要加密密码或恢复码才能导入');
  }

  function validateJSONImport(parsed) {
    if (!parsed || !Array.isArray(parsed.groups)) return '缺少快捷方式数据';
    if (parsed.version !== 2) return '不支持的 JSON 数据版本';
    if (parsed.groups.length > MAX_GROUPS) return `文件中的分组超过 ${MAX_GROUPS} 个`;
    const sizeOf = (value) => new TextEncoder().encode(value).length;
    const settings = parsed.settings;
    if (settings != null) {
      if (typeof settings !== 'object' || Array.isArray(settings)) return '设置格式不正确';
      if (settings.name != null && (typeof settings.name !== 'string' || settings.name.length > 12)) {
        return '昵称超过 12 个字符或格式不正确';
      }
      if (settings.engine != null && (typeof settings.engine !== 'string' || settings.engine.length > 50)) {
        return '搜索引擎标识格式不正确';
      }
      if (settings.customEngines != null) {
        if (!Array.isArray(settings.customEngines) || settings.customEngines.length > 20) return '自定义搜索引擎超过 20 个或格式不正确';
        const engineIds = new Set(ENGINES.map((engine) => engine.id));
        const bangs = new Set(ENGINES.map((engine) => engine.bang));
        for (const engine of settings.customEngines) {
          if (!engine || typeof engine.id !== 'string' || !/^[a-z0-9-]{3,50}$/i.test(engine.id) ||
              engineIds.has(engine.id) || typeof engine.name !== 'string' || !engine.name.trim() ||
              engine.name.length > 20 ||
              typeof engine.template !== 'string' || engine.template.length > 500 ||
              !engine.template.includes('{query}') || !/^https?:\/\//i.test(engine.template) ||
              (engine.bang != null && (typeof engine.bang !== 'string' || !/^[a-z0-9]{0,8}$/.test(engine.bang) ||
                (engine.bang && bangs.has(engine.bang))))) {
            return '自定义搜索引擎格式不正确';
          }
          engineIds.add(engine.id);
          if (engine.bang) bangs.add(engine.bang);
        }
      }
      if (settings.engineOrder != null && (!Array.isArray(settings.engineOrder) || settings.engineOrder.length > 50)) {
        return '搜索引擎顺序格式不正确';
      }
      if (settings.engineOrder && settings.engineOrder.some((id) => typeof id !== 'string')) {
        return '搜索引擎顺序格式不正确';
      }
      const knownEngineIds = new Set([...ENGINES, ...(settings.customEngines || [])].map((engine) => engine.id));
      if (settings.engineOrder && settings.engineOrder.some((id) => !knownEngineIds.has(id))) {
        return '搜索引擎顺序包含未知引擎';
      }
      if (settings.engine && ![...ENGINES, ...(settings.customEngines || [])]
        .some((engine) => engine.id === settings.engine)) {
        return '默认搜索引擎不存在';
      }
    }
    let links = 0;
    const groupIds = new Set();
    const linkIds = new Set();
    for (const group of parsed.groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.links)) {
        return '文件中的分组格式不正确';
      }
      if (typeof group.id !== 'string' || !group.id || groupIds.has(group.id) ||
          typeof group.name !== 'string' || !group.name.trim() || group.name.length > 20) {
        return '文件中的分组 id 或名称无效';
      }
      groupIds.add(group.id);
      links += group.links.length;
      if (links > MAX_LINKS) return `文件中的链接超过 ${MAX_LINKS} 个`;
      for (const link of group.links) {
        if (!link || typeof link !== 'object' || typeof link.id !== 'string' || !link.id || linkIds.has(link.id) ||
            typeof link.title !== 'string' || link.title.length > 40 ||
            (link.icon != null && (typeof link.icon !== 'string' || sizeOf(link.icon) > 200)) ||
            (link.url != null && typeof link.url !== 'string')) {
          return '文件中的链接 id、标题或图标无效';
        }
        linkIds.add(link.id);
        if (!link.deletedAt && (!link.url || sizeOf(link.url) > 2048 || !normalizeLink(link))) {
          return '文件包含无效或过长的链接地址';
        }
      }
    }
    return '';
  }

  function importLimitError(doc) {
    if (doc.groups.length > MAX_GROUPS) return `导入后分组超过 ${MAX_GROUPS} 个`;
    const links = doc.groups.reduce((total, group) =>
      total + (group.deletedAt ? 0 : group.links.length), 0);
    if (links > MAX_LINKS) return `导入后链接超过 ${MAX_LINKS} 个`;
    const plainBytes = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (plainBytes > 256 * 1024) return '导入后导航数据超过 256 KiB 同步预算';
    if (cryptoState.enabled && cryptoState.envelope) {
      const envelopeBytes = new TextEncoder().encode(JSON.stringify({ ...cryptoState.envelope, data: '' })).length;
      const encodedLength = Math.ceil((plainBytes + 28) / 3) * 4;
      if (envelopeBytes + encodedLength > 512 * 1024) {
        return '导入后加密导航数据超过 512 KiB 同步上限';
      }
    }
    return '';
  }

  function planJSONImport(incoming, mode) {
    if (mode === 'replace') {
      const next = stampAll(normalizeData(incoming));
      return { next, addedGroups: countGroups(next), addedLinks: countLinks(next), duplicates: 0 };
    }

    const next = clone(getData());
    const byId = new Map(next.groups.map((group) => [group.id, group]));
    const byName = new Map(next.groups.filter((group) => !group.deletedAt).map((group) => [group.name, group]));
    const knownLinkIds = new Set(next.groups.flatMap((group) => group.links.map((link) => link.id)));
    let addedGroups = 0;
    let addedLinks = 0;
    let duplicates = 0;

    for (const group of incoming.groups) {
      if (group.deletedAt) continue;
      let target = byId.get(group.id) || byName.get(group.name);
      if (target && target.deletedAt) {
        duplicates += group.links.filter((link) => !link.deletedAt).length;
        continue;
      }
      if (!target) {
        target = { ...group, links: [], updatedAt: now() };
        next.groups.push(target);
        byId.set(target.id, target);
        byName.set(target.name, target);
        addedGroups += 1;
      }
      const knownUrls = new Set(target.links
        .map((link) => normalizeUrl(link.url, { allowShortHost: true }).replace(/\/+$/, '')));
      for (const link of group.links) {
        if (link.deletedAt) continue;
        const urlKey = normalizeUrl(link.url, { allowShortHost: true }).replace(/\/+$/, '');
        if (knownLinkIds.has(link.id) || knownUrls.has(urlKey)) {
          duplicates += 1;
          continue;
        }
        target.links.push({ ...link, updatedAt: now(), deletedAt: null });
        target.updatedAt = now();
        knownLinkIds.add(link.id);
        knownUrls.add(urlKey);
        addedLinks += 1;
      }
    }
    return { next, addedGroups, addedLinks, duplicates };
  }

  function updateJSONImportPreview() {
    const pending = state.jsonImport;
    if (!pending) return;
    const mode = $('input[name="json-import-mode"]:checked', dom.jsonImportDialog).value;
    const plan = planJSONImport(pending.incoming, mode);
    const error = importLimitError(plan.next);
    const beforeGroups = countGroups(getData());
    const beforeLinks = countLinks(getData());
    const afterGroups = countGroups(plan.next);
    const afterLinks = countLinks(plan.next);
    dom.jsonImportSummary.textContent = mode === 'merge'
      ? `当前 ${beforeGroups} 个分组、${beforeLinks} 个链接；合并后 ${afterGroups} 个分组、${afterLinks} 个链接。新增 ${plan.addedGroups} 个分组、${plan.addedLinks} 个链接，跳过 ${plan.duplicates} 个重复项；保留当前设置。`
      : `当前 ${beforeGroups} 个分组、${beforeLinks} 个链接；替换后 ${afterGroups} 个分组、${afterLinks} 个链接。当前快捷方式和常规设置将被文件内容替换。`;
    dom.jsonImportError.hidden = !error;
    dom.jsonImportError.textContent = error;
    dom.jsonImportOk.disabled = Boolean(error) || (mode === 'merge' && !plan.addedGroups && !plan.addedLinks);
    dom.jsonImportOk.textContent = mode === 'merge' ? '合并导入' : '替换导入';
    pending.plan = plan;
    pending.mode = mode;
    pending.dataFingerprint = JSON.stringify(getData());
  }

  async function importData(file) {
    if (!file) return;
    ensureDialogs();
    const request = ++state.jsonImportSeq;
    const sessionSeq = sync.sessionSeq;
    const key = currentKey();
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      showToast('导入失败：文件不是有效的 JSON');
      return;
    }
    if (request !== state.jsonImportSeq || sessionSeq !== sync.sessionSeq || key !== currentKey()) return;

    if (globalThis.QingdhCrypto && QingdhCrypto.isEncrypted(parsed)) {
      const decrypted = await promptDecryptFile(parsed);
      if (!decrypted) return;
      parsed = decrypted;
    }
    if (request !== state.jsonImportSeq || sessionSeq !== sync.sessionSeq || key !== currentKey()) return;
    const error = validateJSONImport(parsed);
    if (error) {
      showToast(`导入失败：${error}`);
      return;
    }

    state.jsonImport = { incoming: normalizeData(parsed), sessionSeq, key };
    dom.jsonImportSource.textContent = `文件：${file.name}。文件包含 ${countGroups(state.jsonImport.incoming)} 个分组、${countLinks(state.jsonImport.incoming)} 个链接。`;
    $('input[value="merge"]', dom.jsonImportDialog).checked = true;
    updateJSONImportPreview();
    dom.jsonImportDialog.showModal();
  }

  function applyJSONImport() {
    const pending = state.jsonImport;
    if (!pending) return;
    if (pending.sessionSeq !== sync.sessionSeq || pending.key !== currentKey()) {
      dom.jsonImportDialog.close();
      showToast('账号已变化，请重新选择导入文件');
      return;
    }
    if (pending.dataFingerprint !== JSON.stringify(getData())) {
      updateJSONImportPreview();
      dom.jsonImportError.hidden = false;
      dom.jsonImportError.textContent = '当前数据已变化，请核对更新后的预览并再次确认。';
      return;
    }
    if (importLimitError(pending.plan.next)) {
      updateJSONImportPreview();
      return;
    }
    if (!saveSnapshot('before-import')) return;
    if (!writeJSON(currentKey(), pending.plan.next)) return;
    const nextData = pending.plan.next;
    setData(nextData);
    markDirty();
    broadcastChange();
    render();
    renderClock();
    updateSnapshotButton();
    dom.jsonImportDialog.close();
    dom.hubDialog.close();
    showToast(pending.mode === 'merge'
      ? `已合并 ${pending.plan.addedGroups} 个分组、${pending.plan.addedLinks} 个链接`
      : `已替换为 ${countGroups(nextData)} 个分组、${countLinks(nextData)} 个链接`);
  }

  async function importBookmarks(file) {
    if (!file) return;
    if (!globalThis.QingdhBookmarks) {
      showToast('当前页面不支持书签导入');
      return;
    }

    let parsed;
    try {
      parsed = QingdhBookmarks.parse(await file.text());
    } catch (error) {
      showToast('导入失败：无法解析书签文件');
      return;
    }
    if (!parsed || !parsed.total) {
      showToast('没有找到可导入的书签');
      return;
    }

    const visible = getData().groups.filter((group) => !group.deletedAt);
    const planned = [];
    const plannedNames = new Set(visible.map((group) => group.name));
    let newGroups = 0;
    let newLinks = 0;
    let duplicates = parsed.duplicates || 0;

    // 全工作区按规范化 URL 去重：同一条书签不会因为存在于别的分组而重复导入。
    const knownUrls = new Set();
    for (const group of visible) {
      for (const link of group.links) {
        if (link.deletedAt) continue;
        const url = normalizeUrl(link.url);
        if (url) knownUrls.add(url.replace(/\/+$/, ''));
      }
    }

    for (const group of parsed.groups) {
      const target = visible.find((item) => item.name === group.name) || null;
      const links = [];
      for (const link of group.links) {
        const url = normalizeUrl(link.url);
        if (!url) continue;
        const key = url.replace(/\/+$/, '');
        if (knownUrls.has(key)) {
          duplicates += 1;
          continue;
        }
        knownUrls.add(key);
        links.push({ title: link.title, url });
      }
      if (!links.length) continue;
      if (!target && !plannedNames.has(group.name)) {
        newGroups += 1;
        plannedNames.add(group.name);
      }
      newLinks += links.length;
      planned.push({ group, target, links });
    }

    if (!newLinks) {
      showToast(`没有新的书签${duplicates ? `（跳过 ${duplicates} 个重复）` : ''}`);
      return;
    }

    openBookmarkImport(planned, { duplicates, newLinks, newGroups });
  }

  function uniqueGroupName(base, used) {
    let name = String(base || '导入的书签').slice(0, 20);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    for (let i = 2; i < 100; i += 1) {
      const suffix = ` (${i})`;
      const candidate = `${name.slice(0, 20 - suffix.length)}${suffix}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    return name;
  }

  function openBookmarkImport(planned, { duplicates, newLinks, newGroups }) {
    ensureDialogs();
    if (!dom.bookmarkImportDialog) return;
    const visible = getData().groups.filter((group) => !group.deletedAt);
    const usedNames = new Set(visible.map((group) => group.name));
    for (const item of planned) {
      item.newName = item.target ? item.target.name : uniqueGroupName(item.group.name, usedNames);
    }
    state.bookmarkImport = { planned, duplicates };
    if (dom.bookmarkImportSummary) {
      dom.bookmarkImportSummary.textContent = `将导入 ${newLinks} 个链接、${newGroups} 个新分组${
        duplicates ? `，跳过 ${duplicates} 个重复网址` : ''
      }。可以为每个目录选择现有分组，或保留新建分组。`;
    }
    dom.bookmarkImportList.innerHTML = planned
      .map((item, index) => {
        const options = [
          item.target
            ? ''
            : `<option value="new">新建分组「${escapeHTML(item.newName)}」</option>`,
          ...visible.map(
            (group) =>
              `<option value="existing:${escapeHTML(group.id)}" ${
                item.target && item.target.id === group.id ? 'selected' : ''
              }>${escapeHTML(group.name)}</option>`
          ),
        ];
        if (item.target) {
          options.unshift(
            `<option value="new">改为新建分组「${escapeHTML(item.newName)}」</option>`
          );
        }
        return `<div class="bookmark-import-row">
          <div class="bookmark-import-copy">
            <strong>${escapeHTML(item.group.name)}</strong>
            <small title="${escapeHTML(item.group.path)}">${escapeHTML(
              item.group.path
            )} · ${item.links.length} 个链接</small>
          </div>
          <select data-bookmark-target="${index}" aria-label="「${escapeHTML(
            item.group.name
          )}」的目标分组">${options.join('')}</select>
        </div>`;
      })
      .join('');
    dom.bookmarkImportList.querySelectorAll('select').forEach((select) => {
      if (globalThis.QingdhSelect) QingdhSelect.enhance(select);
    });
    dom.bookmarkImportDialog.showModal();
  }

  function applyBookmarkImport() {
    const pending = state.bookmarkImport;
    if (!pending) return;
    const planned = pending.planned;
    saveSnapshot('before-bookmarks');
    let added = 0;
    let limitHit = false;
    let createdGroups = 0;
    const created = new Map();

    for (let index = 0; index < planned.length; index += 1) {
      if (limitHit) break;
      const item = planned[index];
      const select = dom.bookmarkImportList.querySelector(
        `[data-bookmark-target="${index}"]`
      );
      const choice = select ? select.value : 'new';
      let target = null;
      if (choice.startsWith('existing:')) {
        target = getData().groups.find((group) => group.id === choice.slice(9) && !group.deletedAt) || null;
      }
      if (!target && created.has(item.newName)) {
        target = created.get(item.newName);
      }
      if (!target) {
        if (getData().groups.filter((group) => !group.deletedAt).length >= MAX_GROUPS) {
          limitHit = true;
          break;
        }
        target = makeGroup(item.newName);
        getData().groups.push(target);
        created.set(item.newName, target);
        createdGroups += 1;
      }
      for (const link of item.links) {
        if (countLinks(getData()) >= MAX_LINKS) {
          limitHit = true;
          break;
        }
        target.links.push(makeLink(link.title, link.url));
        added += 1;
      }
      target.updatedAt = now();
    }

    state.bookmarkImport = null;
    if (dom.bookmarkImportDialog && dom.bookmarkImportDialog.open) dom.bookmarkImportDialog.close();
    const dropped = enforceLimits(getData());
    commitLocalChange();
    dom.hubDialog.close();
    if (limitHit) showToast(`已导入 ${added} 个书签，达到数量上限后停止`);
    else if (dropped > 0) showToast(`已导入 ${added} 个书签，省略 ${dropped} 项超限数据`);
    else showToast(`已导入 ${added} 个书签${createdGroups ? `，新建 ${createdGroups} 个分组` : ''}`);
  }

  async function resetData() {
    const confirmed = await askConfirm({
      title: '恢复默认',
      message: '将清除所有自定义快捷方式，恢复为初始状态。确定继续吗？',
      confirmText: '恢复默认',
    });
    if (!confirmed) return;

    saveSnapshot('before-reset');
    setData(createDefaultData());
    commitLocalChange();
    dom.hubDialog.close();
    showToast('已恢复默认设置');
  }

  async function restoreSnapshot() {
    const result = readSnapshot();
    if (result.status !== 'ready') {
      showToast(result.status === 'legacy'
        ? '旧备份缺少账号归属，无法安全恢复'
        : result.status === 'other'
          ? '备份属于其他账号，无法恢复'
          : '没有可用的备份');
      return;
    }
    const snapshot = result.snapshot;
    const owner = currentKey();
    const sessionSeq = sync.sessionSeq;
    const snapshotFingerprint = JSON.stringify(snapshot);
    const confirmed = await askConfirm({
      title: '恢复备份',
      message: `将用 ${formatTime(snapshot.at)} 的备份覆盖当前数据，确定继续吗？`,
      confirmText: '恢复',
      danger: false,
    });
    if (!confirmed) return;
    const latest = readSnapshot();
    if (owner !== currentKey() || sessionSeq !== sync.sessionSeq || latest.status !== 'ready' ||
        JSON.stringify(latest.snapshot) !== snapshotFingerprint) {
      showToast('账号或备份已变化，请重新查看备份');
      return;
    }

    setData(stampAll(normalizeData(snapshot.data)));
    commitLocalChange();
    dom.hubDialog.close();
    showToast('已恢复备份');
  }

    return {
      HUB_GROUPS,
      HUB_PANELS,
      openHub,
      openSettings,
      openAIConfig,
      openAccountDialog,
      setHubTab,
      syncSettingsUI,
      updateAIConfigGate,
      exportData,
      updateJSONImportPreview,
      importData,
      applyJSONImport,
      importBookmarks,
      openBookmarkImport,
      applyBookmarkImport,
      resetData,
      restoreSnapshot,
      validateJSONImport,
      planJSONImport,
    };
  }

  return { create };
});
