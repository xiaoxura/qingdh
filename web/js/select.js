/* 轻量自定义下拉框：保留原生 select 作为值来源，弹出层用 Popover 避免被
 * <dialog> 的 top layer 遮住。 */
(function () {
  'use strict';

  const instances = new WeakMap();
  let openApi = null;
  let counter = 0;

  const ARROW = `<svg class="qselect-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const CHECK = `<svg class="qselect-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>`;

  function enhance(select) {
    if (!select) return null;
    const existing = instances.get(select);
    if (existing) return existing;

    const api = create(select);
    instances.set(select, api);
    return api;
  }

  function create(select) {
    const baseId = select.id || `qselect-${++counter}`;
    const wrap = document.createElement('div');
    wrap.className = 'qselect';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    select.classList.add('qselect-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'qselect-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const value = document.createElement('span');
    value.className = 'qselect-value';
    value.id = `${baseId}-custom-value`;
    trigger.appendChild(value);
    trigger.insertAdjacentHTML('beforeend', ARROW);
    wrap.appendChild(trigger);

    const menu = document.createElement('div');
    menu.className = 'qselect-menu';
    menu.id = `${baseId}-custom-menu`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('popover', 'manual');
    // A modal <dialog> makes everything outside it inert. A popover appended to
    // <body> is visible above the dialog but cannot receive clicks, so keep it
    // inside the dialog's subtree while still using the top layer.
    const owningDialog = select.closest('dialog');
    (owningDialog || document.body).appendChild(menu);
    trigger.setAttribute('aria-controls', menu.id);

    const fieldLabel = select.id
      ? document.querySelector(`label[for="${select.id.replace(/"/g, '\\"')}"]`)
      : null;
    if (fieldLabel) {
      if (!fieldLabel.id) fieldLabel.id = `${baseId}-custom-label`;
      trigger.setAttribute('aria-labelledby', `${fieldLabel.id} ${value.id}`);
    } else if (select.getAttribute('aria-label')) {
      trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
    }

    const state = { open: false, active: -1 };

    function options() {
      return Array.from(select.options).filter((option) => !option.disabled && !option.hidden);
    }

    function selectedIndex() {
      return options().findIndex((option) => option.value === select.value);
    }

    function syncLabel() {
      const option = select.options[select.selectedIndex];
      value.textContent = option ? option.textContent.trim() : '';
      value.title = value.textContent;
    }

    function setActive(index) {
      const items = menu.querySelectorAll('.qselect-option');
      if (!items.length) {
        state.active = -1;
        return;
      }
      state.active = Math.max(0, Math.min(index, items.length - 1));
      items.forEach((item, i) => item.classList.toggle('is-active', i === state.active));
      items[state.active].scrollIntoView({ block: 'nearest' });
    }

    function renderOptions() {
      const items = options();
      menu.innerHTML = '';
      state.active = -1;

      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'qselect-empty';
        empty.textContent = '暂无可选项';
        menu.appendChild(empty);
        return;
      }

      items.forEach((option, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'qselect-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', option.value === select.value ? 'true' : 'false');
        item.dataset.index = String(index);
        item.tabIndex = -1;

        const label = document.createElement('span');
        label.className = 'qselect-option-label';
        label.textContent = option.textContent.trim();
        label.title = label.textContent;
        item.appendChild(label);
        item.insertAdjacentHTML('beforeend', CHECK);

        if (option.value === select.value) state.active = index;
        menu.appendChild(item);
      });

      if (state.active < 0) state.active = 0;
    }

    function position() {
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(Math.max(rect.width, 168), window.innerWidth - margin * 2);
      const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const openUp = spaceBelow < 150 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(96, Math.min(320, openUp ? spaceAbove : spaceBelow));

      menu.style.width = `${width}px`;
      menu.style.left = `${left}px`;
      menu.style.maxHeight = `${maxHeight}px`;
      if (openUp) {
        menu.style.top = 'auto';
        menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      } else {
        menu.style.bottom = 'auto';
        menu.style.top = `${rect.bottom + 6}px`;
      }
    }

    function move(delta) {
      const count = options().length;
      if (!count) return;
      setActive((state.active + delta + count) % count);
    }

    function choose(index) {
      const option = options()[index];
      if (!option) return;
      const changed = select.value !== option.value;
      close();
      if (changed) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        syncLabel();
      }
      trigger.focus();
    }

    function onPointerDown(event) {
      if (trigger.contains(event.target) || menu.contains(event.target)) return;
      close();
    }

    function onScroll(event) {
      if (menu.contains(event.target)) return;
      close();
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape' || !state.open) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    }

    function open() {
      if (state.open) return;
      if (openApi && openApi !== api) openApi.close();

      syncLabel();
      renderOptions();
      state.open = true;
      trigger.setAttribute('aria-expanded', 'true');
      wrap.classList.add('is-open');
      menu.classList.add('is-open');

      if (typeof menu.showPopover === 'function') {
        try {
          if (!menu.matches(':popover-open')) menu.showPopover();
        } catch (error) {
          // 旧浏览器没有 Popover，仍可用固定定位显示。
        }
      }

      position();
      setActive(selectedIndex());
      openApi = api;
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', onScroll, true);

      const dialog = trigger.closest('dialog');
      if (dialog) dialog.addEventListener('close', close);
    }

    function close() {
      if (!state.open) return;
      state.open = false;
      trigger.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('is-open');
      menu.classList.remove('is-open');

      if (typeof menu.hidePopover === 'function') {
        try {
          if (menu.matches(':popover-open')) menu.hidePopover();
        } catch (error) {
          // ignore
        }
      }

      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);

      const dialog = trigger.closest('dialog');
      if (dialog) dialog.removeEventListener('close', close);
      if (openApi === api) openApi = null;
    }

    function sync() {
      syncLabel();
      if (state.open) {
        renderOptions();
        setActive(selectedIndex());
        position();
      }
    }

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (state.open) close();
      else open();
    });

    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!state.open) open();
        else move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (state.open) choose(state.active);
        else open();
        return;
      }
      if (event.key === 'Escape' && state.open) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === 'Tab' && state.open) close();
    });

    menu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-index]');
      if (item) choose(Number(item.dataset.index));
    });

    menu.addEventListener('pointerover', (event) => {
      const item = event.target.closest('[data-index]');
      if (item) setActive(Number(item.dataset.index));
    });

    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        trigger.focus();
      }
    });

    select.addEventListener('change', () => {
      syncLabel();
      if (state.open) sync();
    });

    if (fieldLabel) {
      fieldLabel.addEventListener('click', (event) => {
        if (event.target.closest('a')) return;
        event.preventDefault();
        trigger.focus();
        open();
      });
    }

    const observer = new MutationObserver(() => {
      syncLabel();
      if (state.open) sync();
    });
    observer.observe(select, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'label'],
    });

    const api = { select, trigger, menu, open, close, sync };
    syncLabel();
    return api;
  }

  function sync(select) {
    const api = instances.get(select);
    if (api) api.sync();
  }

  function enhanceAll(root = document) {
    root.querySelectorAll('select').forEach(enhance);
  }

  globalThis.QingdhSelect = { enhance, enhanceAll, sync };
})();
