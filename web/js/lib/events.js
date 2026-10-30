/* ==========================================================================
 * 氢导航 · 事件绑定
 *
 * 搜索、引擎菜单、编辑、侧栏、设置 Hub、导入导出、认证、加密/历史版本等
 * 所有 DOM 事件集中在此。bindEvents(deps) 由 app.js 在启动时调用一次。
 * ========================================================================== */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QingdhEvents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(deps) {
    const {
      dom,
      state,
      prefs,
      sync,
      cryptoState,
      $$,
      CLOCK_STYLES,
      HOUR_CYCLES,
      SEASONS,
      addCustomEngine,
      api,
      apiError,
      applyClockPrefs,
      applyDensity,
      applySidebar,
      applyTheme,
      bindDialogShells,
      closeDrawer,
      commitLocalChange,
      deleteGroup,
      deleteLink,
      ensureDialogs,
      escapeHTML,
      focusSearch,
      forgetDevice,
      hideToast,
      hideUrlError,
      importBookmarks,
      importData,
      isDialogOpen,
      isMobileLayout,
      isTypingTarget,
      loadSessions,
      moveEngineOrder,
      now,
      openAccountDialog,
      openGroupDialog,
      openHub,
      openLinkDialog,
      openSettings,
      previewRevision,
      removeCustomEngine,
      removeHistoryItem,
      render,
      renderEngineSettings,
      renderSearchHistory,
      renderSyncManager,
      resolveDecryptFile,
      resolvePasskey,
      resolveTheme,
      resolveUnlock,
      restartClock,
      restoreRevision,
      restoreSidebarMode,
      runHistorySearch,
      savePrefs,
      scheduleSync,
      selectEngine,
      setAuthView,
      setBatchMode,
      setDefaultEngine,
      setEditing,
      setEngineMenu,
      setHubTab,
      setSidebarMode,
      setStatus,
      settleConfirm,
      settleMerge,
      showToast,
      sidebarMode,
      syncNow,
      syncSettingsSidebarUI,
      syncSettingsUI,
      toggleBatchLink,
      toggleGroup,
      toggleNewGroupField,
      toggleSidebar,
      trapDrawerFocus,
      updateEngineUI,
      updateJSONImportPreview,
      withOptionalModule,
      writeSyncMeta,
      applyBookmarkImport,
      applyJSONImport,
      batchCheckDuplicates,
      batchDeleteSelected,
      batchMoveSelected,
      clearSearchHistory,
      copyNewRecoveryCode,
      copyRecoveryCode,
      downloadNewRecoveryCode,
      downloadRecoveryCode,
      enablePasskey,
      exportData,
      finishEncryption,
      finishRotateRecovery,
      focusSyncAllowed,
      getConfirmResolver,
      getData,
      getToastActionHandler,
      handleChangeEmail,
      handleChangePassword,
      handleDeleteAccount,
      handleForgot,
      handleGroupSubmit,
      handleLinkSubmit,
      handleLogin,
      handleLogout,
      handleLogoutAll,
      handleRegister,
      handleResetPassword,
      handleSearch,
      openChangeEmailDialog,
      openChangeEncryptionDialog,
      openChangePasswordDialog,
      openDisableEncryptionDialog,
      openDrawer,
      openEncryptDialog,
      openRevisionsDialog,
      openRotateRecoveryDialog,
      openSearchHistory,
      removePasskey,
      resendVerification,
      resetData,
      restoreSnapshot,
      setConfirmResolver,
      setToastActionHandler,
      submitChangeEncryption,
      submitDecryptFile,
      submitDisableEncryption,
      submitEncrypt,
      submitPasskey,
      submitRotateRecovery,
      submitUnlock,
      unlockFromPanel,
    } = deps;

    function bindEvents() {
    dom.searchForm.addEventListener('submit', handleSearch);
    dom.searchInput.addEventListener('compositionstart', () => {
      dom.searchInput.dataset.composing = 'true';
    });
    dom.searchInput.addEventListener('compositionend', () => {
      dom.searchInput.dataset.composing = 'false';
    });

    dom.engineBtn.addEventListener('click', () => setEngineMenu(!state.engineMenuOpen));
    dom.engineBtn.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setEngineMenu(true);
      }
    });

    dom.engineMenu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-engine]');
      if (option) selectEngine(option.dataset.engine);
    });

    dom.engineMenu.addEventListener('keydown', (event) => {
      const options = $$('.engine-option', dom.engineMenu);
      const index = options.indexOf(document.activeElement);

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        options[(index + step + options.length) % options.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setEngineMenu(false);
        dom.engineBtn.focus();
      } else if (event.key === 'Tab') {
        setEngineMenu(false);
      }
    });

    dom.searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setEngineMenu(false);
      if (dom.searchInput.value) {
        dom.searchInput.value = '';
      } else {
        dom.searchInput.blur();
      }
    });

    dom.groups.addEventListener('click', (event) => {
      if (state.batchMode) {
        const row = event.target.closest('.link-row[data-batch-row], .link-row');
        const link = row && row.querySelector('[data-link-id]');
        if (link) {
          event.preventDefault();
          toggleBatchLink(link.dataset.linkId);
          return;
        }
      }
      const actionEl = event.target.closest('[data-action]');

      if (actionEl) {
        event.preventDefault();
        const { action } = actionEl.dataset;

        if (action === 'delete-link') deleteLink(actionEl.dataset.linkId);
        else if (action === 'delete-group') deleteGroup(actionEl.dataset.groupId);
        else if (action === 'add-link') openLinkDialog({ groupId: actionEl.dataset.groupId });
        else if (action === 'toggle-group') toggleGroup(actionEl.dataset.groupId);
        return;
      }

      const titleEl = event.target.closest('.group-title');
      if (titleEl && state.editing) {
        openGroupDialog({ groupId: titleEl.closest('.group').dataset.groupId });
        return;
      }

      const linkEl = event.target.closest('a.link');
      if (linkEl && state.editing) {
        event.preventDefault();
        openLinkDialog({ linkId: linkEl.dataset.linkId });
      }
    });

    dom.groups.addEventListener('keydown', (event) => {
      if (!state.editing) return;
      const titleEl = event.target.closest('.group-title');
      if (titleEl && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        openGroupDialog({ groupId: titleEl.closest('.group').dataset.groupId });
      }
    });

    dom.editBtn.addEventListener('click', () => setEditing(!state.editing));
    dom.settingsBtn.addEventListener('click', () => {
      if (state.drawerOpen) closeDrawer({ restoreFocus: false });
      openSettings();
    });
    dom.accountBtn.addEventListener('click', () => {
      if (state.drawerOpen) closeDrawer({ restoreFocus: false });
      openAccountDialog();
    });
    dom.brand.addEventListener('click', (event) => {
      if (isMobileLayout()) return;
      if (sidebarMode() !== 'collapsed') return;
      event.preventDefault();
      setSidebarMode('expanded');
    });

    dom.homeNav.addEventListener('click', (event) => {
      if (globalThis.QingdhMemo && QingdhMemo.isOpen()) {
        event.preventDefault();
        QingdhMemo.close();
      }
    });
    dom.historyNav.addEventListener('click', openSearchHistory);
    dom.historySearch.addEventListener('input', renderSearchHistory);
    dom.historyKinds.forEach((button) => button.addEventListener('click', () => {
      state.historyKind = button.dataset.historyKind;
      dom.historyKinds.forEach((item) => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      renderSearchHistory();
    }));
    dom.historyList.addEventListener('click', (event) => {
      const open = event.target.closest('[data-history-open]');
      if (open) {
        runHistorySearch(Number(open.dataset.historyOpen), open.dataset.historyAction);
        return;
      }
      const remove = event.target.closest('[data-history-remove]');
      if (remove) removeHistoryItem(Number(remove.dataset.historyRemove));
    });
    dom.historyClear.addEventListener('click', clearSearchHistory);

    dom.memoNav.addEventListener('click', () => {
      if (state.drawerOpen) closeDrawer({ restoreFocus: false });
      withOptionalModule('QingdhMemo', () => QingdhMemo.toggle());
    });

    if (dom.hubCategory) {
      dom.hubCategory.innerHTML = dom.hubTabs
        .map(
          (button) =>
            `<option value="${escapeHTML(button.dataset.hubTab)}">${escapeHTML(
              button.dataset.title || button.textContent.trim()
            )}</option>`
        )
        .join('');
      dom.hubCategory.value = 'account';
      if (globalThis.QingdhSelect) QingdhSelect.enhance(dom.hubCategory);
      dom.hubCategory.addEventListener('change', () => {
        setHubTab(dom.hubCategory.value);
      });
    }

    dom.hubTabs.forEach((button) => {
      button.addEventListener('click', () => {
        setHubTab(button.dataset.hubTab);
      });
    });
    if (dom.hubSubnav) {
      dom.hubSubnav.addEventListener('click', (event) => {
        const button = event.target.closest('[data-hub-subtab]');
        if (button) setHubTab(button.dataset.hubSubtab);
      });
      dom.hubSubnav.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const items = Array.from(dom.hubSubnav.querySelectorAll('[data-hub-subtab]'));
        const index = items.indexOf(document.activeElement);
        if (index < 0) return;
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = items[(index + step + items.length) % items.length];
        next.focus();
        next.click();
      });
    }
    if (dom.aiConfigGateAction) {
      dom.aiConfigGateAction.addEventListener('click', () => {
        setHubTab(sync.user ? 'encryption' : 'account');
      });
    }

    dom.sidebarCollapse.addEventListener('click', toggleSidebar);
    dom.sidebarHide.addEventListener('click', () => setSidebarMode('hidden'));
    dom.sidebarReveal.addEventListener('click', () => setSidebarMode(restoreSidebarMode()));
    dom.sidebarOpen.addEventListener('click', openDrawer);
    dom.sidebarScrim.addEventListener('click', () => closeDrawer());
    dom.syncBadge.addEventListener('click', () => openHub('sync'));
    dom.sidebar.addEventListener('mouseenter', () => {
      if (!prefs.sidebarAutoCollapse || isMobileLayout()) return;
      if (!state.hoverCollapsed) return;
      state.hoverCollapsed = false;
      applySidebar();
    });
    dom.sidebar.addEventListener('mouseleave', () => {
      if (!prefs.sidebarAutoCollapse || isMobileLayout()) return;
      if (prefs.sidebar !== 'expanded' || state.hoverCollapsed) return;
      if (isDialogOpen()) return;
      state.hoverCollapsed = true;
      applySidebar();
    });

    dom.themeBtn.addEventListener('click', () => {
      prefs.theme = resolveTheme() === 'dark' ? 'light' : 'dark';
      savePrefs();
      applyTheme();
      syncSettingsUI();
    });

    dom.addLinkBtn.addEventListener('click', () => openLinkDialog());
    dom.addGroupBtn.addEventListener('click', () => openGroupDialog());
    dom.batchBtn.addEventListener('click', () => setBatchMode(!state.batchMode));
    dom.batchMove.addEventListener('click', batchMoveSelected);
    dom.batchDuplicates.addEventListener('click', batchCheckDuplicates);
    dom.batchDelete.addEventListener('click', batchDeleteSelected);
    dom.batchCancel.addEventListener('click', () => setBatchMode(false));

    dom.linkGroup.addEventListener('change', () => {
      toggleNewGroupField();
      if (!dom.linkGroupName.hidden) dom.linkGroupName.focus();
    });
    dom.linkForm.addEventListener('submit', handleLinkSubmit);
    dom.linkUrl.addEventListener('input', hideUrlError);
    dom.linkDialog.addEventListener('close', () => {
      state.linkEditId = null;
      hideUrlError();
    });

    dom.groupForm.addEventListener('submit', handleGroupSubmit);
    dom.groupDialog.addEventListener('close', () => {
      state.groupEditId = null;
    });

    dom.setName.addEventListener('input', () => {
      getData().settings.name = dom.setName.value.trim().slice(0, 12);
      getData().settings.updatedAt = now();
      commitLocalChange();
    });

    dom.setEngine.addEventListener('change', () => {
      getData().settings.engine = dom.setEngine.value;
      getData().settings.updatedAt = now();
      commitLocalChange();
      updateEngineUI();
      renderEngineSettings();
    });

    dom.engineConfigList.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-engine-remove]');
      if (remove) {
        removeCustomEngine(remove.dataset.engineRemove);
        return;
      }
      const button = event.target.closest('[data-engine-default]');
      if (!button) return;
      setDefaultEngine(button.dataset.engineDefault);
    });

    dom.engineAddBtn.addEventListener('click', addCustomEngine);
    dom.engineAddOpen.addEventListener('click', () => {
      dom.engineAddError.hidden = true;
      dom.engineNewName.value = '';
      dom.engineNewBang.value = '';
      dom.engineNewUrl.value = '';
      dom.engineAddDialog.showModal();
      requestAnimationFrame(() => dom.engineNewName.focus());
    });
    dom.engineConfigList.addEventListener('dragstart', (event) => {
      const row = event.target.closest('[data-engine-id]');
      if (!row) return;
      engineDragId = row.dataset.engineId;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', engineDragId);
    });
    dom.engineConfigList.addEventListener('dragover', (event) => {
      const row = event.target.closest('[data-engine-id]');
      if (!row || !engineDragId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      dom.engineConfigList.querySelectorAll('.is-drag-over').forEach((item) => item.classList.remove('is-drag-over'));
      row.classList.add('is-drag-over');
    });
    dom.engineConfigList.addEventListener('drop', (event) => {
      const row = event.target.closest('[data-engine-id]');
      if (!row) return;
      event.preventDefault();
      moveEngineOrder(engineDragId, row.dataset.engineId);
      engineDragId = null;
    });
    dom.engineConfigList.addEventListener('dragend', () => {
      engineDragId = null;
      dom.engineConfigList.querySelectorAll('.is-dragging, .is-drag-over').forEach((item) => {
        item.classList.remove('is-dragging', 'is-drag-over');
      });
    });
    [dom.engineNewName, dom.engineNewBang, dom.engineNewUrl].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addCustomEngine();
      });
    });

    dom.setOpen.addEventListener('change', () => {
      prefs.openInNewTab = dom.setOpen.value === 'new';
      savePrefs();
      render();
    });

    dom.setDensity.addEventListener('change', () => {
      prefs.density = dom.setDensity.value === 'compact' ? 'compact' : 'comfortable';
      savePrefs();
      applyDensity();
    });

    dom.setTheme.addEventListener('change', () => {
      prefs.theme = dom.setTheme.value;
      savePrefs();
      applyTheme();
    });

    dom.setClock.addEventListener('change', () => {
      prefs.clockStyle = CLOCK_STYLES.includes(dom.setClock.value) ? dom.setClock.value : 'editorial';
      applyClockPrefs();
      savePrefs();
      restartClock();
    });

    dom.setHour.addEventListener('change', () => {
      prefs.hourCycle = HOUR_CYCLES.includes(dom.setHour.value) ? dom.setHour.value : 'auto';
      applyClockPrefs();
      savePrefs();
      restartClock();
    });

    dom.setSeconds.addEventListener('change', () => {
      prefs.showSeconds = dom.setSeconds.checked;
      savePrefs();
      restartClock();
    });

    dom.setSidebar.addEventListener('change', () => {
      setSidebarMode(dom.setSidebar.value);
      syncSettingsSidebarUI();
    });

    dom.setSidebarSide.addEventListener('change', () => {
      prefs.sidebarSide = dom.setSidebarSide.value === 'right' ? 'right' : 'left';
      savePrefs();
      applySidebar();
    });

    dom.setSidebarHover.addEventListener('change', () => {
      prefs.sidebarAutoCollapse = dom.setSidebarHover.checked;
      if (!prefs.sidebarAutoCollapse) state.hoverCollapsed = false;
      savePrefs();
      applySidebar();
    });

    dom.seasonPicker.addEventListener('change', (event) => {
      const input = event.target.closest('input[name="season"]');
      if (!input || !SEASONS.includes(input.value)) return;
      prefs.season = input.value;
      savePrefs();
      applyTheme();
    });

    dom.deviceForget.addEventListener('click', () => forgetDevice());
    dom.passkeyEnable.addEventListener('click', enablePasskey);
    dom.passkeyRemove.addEventListener('click', removePasskey);
    dom.passkeyVerify.addEventListener('click', submitPasskey);
    dom.passkeyUsePassword.addEventListener('click', () => resolvePasskey(false));
    dom.passkeyDialog.addEventListener('close', () => resolvePasskey(false));

    dom.encryptionEnable.addEventListener('click', openEncryptDialog);
    dom.encryptionUnlock.addEventListener('click', unlockFromPanel);
    dom.encryptionChange.addEventListener('click', openChangeEncryptionDialog);
    dom.encryptionRecovery.addEventListener('click', openRotateRecoveryDialog);
    dom.encryptionDisable.addEventListener('click', openDisableEncryptionDialog);
    dom.disableEncryptionForm.addEventListener('submit', submitDisableEncryption);
    dom.disableEncryptionDiscard.addEventListener('change', () => {
      if (dom.disableEncryptionDiscard.checked) dom.disableEncryptionError.hidden = true;
    });
    dom.rotateRecoveryForm.addEventListener('submit', submitRotateRecovery);
    dom.newRecoverySave.addEventListener('click', finishRotateRecovery);
    dom.newRecoveryCopy.addEventListener('click', copyNewRecoveryCode);
    dom.newRecoveryDownload.addEventListener('click', downloadNewRecoveryCode);
    dom.newRecoveryConfirm.addEventListener('change', () => {
      if (dom.newRecoveryConfirm.checked) dom.newRecoveryError.hidden = true;
    });
    dom.newRecoveryDialog.addEventListener('close', () => {
      if (cryptoState.pendingRecovery) {
        cryptoState.pendingRecovery = null;
        showToast('已取消，旧恢复码继续有效');
      }
    });
    dom.encryptForm.addEventListener('submit', submitEncrypt);
    dom.changeEncryptionForm.addEventListener('submit', submitChangeEncryption);
    dom.changeEncryptionRecoveryToggle.addEventListener('change', () => {
      const useRecovery = dom.changeEncryptionRecoveryToggle.checked;
      dom.changeEncryptionOldField.hidden = useRecovery;
      dom.changeEncryptionRecoveryField.hidden = !useRecovery;
      dom.changeEncryptionError.hidden = true;
      setTimeout(() => (useRecovery ? dom.changeEncryptionRecovery : dom.changeEncryptionOld).focus(), 20);
    });
    dom.recoveryContinue.addEventListener('click', finishEncryption);
    dom.recoveryCopy.addEventListener('click', copyRecoveryCode);
    dom.recoveryDownload.addEventListener('click', downloadRecoveryCode);
    dom.recoveryConfirm.addEventListener('change', () => {
      if (dom.recoveryConfirm.checked) dom.recoveryError.hidden = true;
    });
    dom.recoveryDialog.addEventListener('close', () => {
      if (cryptoState.pendingSetup) {
        cryptoState.pendingSetup = null;
        showToast('已取消开启加密');
      }
    });

    dom.unlockForm.addEventListener('submit', submitUnlock);
    dom.unlockRecoveryToggle.addEventListener('change', () => {
      const recovery = dom.unlockRecoveryToggle.checked;
      dom.unlockRecoveryField.hidden = !recovery;
      dom.unlockError.hidden = true;
      setTimeout(() => (recovery ? dom.unlockRecovery : dom.unlockPassword).focus(), 20);
    });
    dom.unlockLater.addEventListener('click', () => resolveUnlock(null));
    dom.unlockDialog.addEventListener('close', () => resolveUnlock(null));

    dom.decryptFileForm.addEventListener('submit', submitDecryptFile);
    dom.decryptFileRecoveryToggle.addEventListener('change', () => {
      const recovery = dom.decryptFileRecoveryToggle.checked;
      dom.decryptFileRecoveryField.hidden = !recovery;
      dom.decryptFileError.hidden = true;
      setTimeout(() => (recovery ? dom.decryptFileRecovery : dom.decryptFilePassword).focus(), 20);
    });
    dom.decryptFileCancel.addEventListener('click', () => resolveDecryptFile(null));
    dom.decryptFileDialog.addEventListener('close', () => resolveDecryptFile(null));

    dom.revisionsBtn.addEventListener('click', openRevisionsDialog);
    dom.revisionsList.addEventListener('click', (event) => {
      const preview = event.target.closest('[data-revision-preview]');
      if (preview) {
        previewRevision(preview.dataset.revisionPreview);
        return;
      }
      const restore = event.target.closest('[data-revision-restore]');
      if (restore) restoreRevision(restore.dataset.revisionRestore);
    });
    dom.exportBtn.addEventListener('click', exportData);
    dom.importBtn.addEventListener('click', () => dom.importFile.click());
    dom.importBookmarksBtn.addEventListener('click', () => dom.bookmarksFile.click());
    dom.bookmarksFile.addEventListener('change', () => {
      const file = dom.bookmarksFile.files && dom.bookmarksFile.files[0];
      dom.bookmarksFile.value = '';
      if (file) withOptionalModule('QingdhBookmarks', () => importBookmarks(file));
    });
    if (dom.bookmarkImportOk) dom.bookmarkImportOk.addEventListener('click', applyBookmarkImport);
    if (dom.bookmarkImportDialog) {
      dom.bookmarkImportDialog.addEventListener('close', () => {
        state.bookmarkImport = null;
      });
    }
    dom.importFile.addEventListener('change', () => {
      const file = dom.importFile.files && dom.importFile.files[0];
      dom.importFile.value = '';
      importData(file);
    });
    dom.jsonImportDialog.addEventListener('change', (event) => {
      if (event.target.name === 'json-import-mode') updateJSONImportPreview();
    });
    dom.jsonImportDialog.addEventListener('close', () => {
      state.jsonImport = null;
    });
    dom.jsonImportOk.addEventListener('click', applyJSONImport);
    dom.restoreSnapshotBtn.addEventListener('click', restoreSnapshot);
    dom.resetBtn.addEventListener('click', resetData);

    $$('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => setAuthView(tab.dataset.authView));
    });
    dom.loginForm.addEventListener('submit', handleLogin);
    dom.registerForm.addEventListener('submit', handleRegister);
    dom.forgotForm.addEventListener('submit', handleForgot);
    dom.forgotLink.addEventListener('click', () => {
      dom.forgotEmail.value = dom.loginEmail.value.trim();
      setAuthView('forgot');
    });
    dom.forgotBack.addEventListener('click', () => setAuthView('login'));
    dom.resendLink.addEventListener('click', resendVerification);
    dom.resetForm.addEventListener('submit', handleResetPassword);
    dom.deleteForm.addEventListener('submit', handleDeleteAccount);

    if (dom.syncPageNow) dom.syncPageNow.addEventListener('click', () => syncNow({ manual: true }));
    if (dom.syncAutoToggle) {
      dom.syncAutoToggle.addEventListener('change', () => {
        prefs.autoSync = dom.syncAutoToggle.checked;
        savePrefs();
        if (prefs.autoSync) syncNow({ manual: true });
        else if (sync.dirty) setStatus(sync.online ? 'dirty' : 'offline');
        renderSyncManager();
      });
    }
    if (dom.syncItemList) {
      dom.syncItemList.addEventListener('change', (event) => {
        const input = event.target.closest('[data-sync-scope]');
        if (!input) return;
        const key = input.dataset.syncScope;
        if (key !== 'groups' && key !== 'settings') return;
        prefs.syncScope[key] = input.checked;
        savePrefs();
        if (sync.user) {
          sync.dirty = true;
          writeSyncMeta();
          setStatus(sync.online ? 'dirty' : 'offline');
          scheduleSync(0);
        }
        renderSyncManager();
      });
    }
    dom.logoutBtn.addEventListener('click', handleLogout);
    dom.logoutAllBtn.addEventListener('click', handleLogoutAll);
    dom.changeEmailBtn.addEventListener('click', openChangeEmailDialog);
    dom.changeEmailForm.addEventListener('submit', handleChangeEmail);
    dom.changePasswordBtn.addEventListener('click', openChangePasswordDialog);
    dom.changePasswordForm.addEventListener('submit', handleChangePassword);
    dom.deleteAccountBtn.addEventListener('click', () => {
      ensureDialogs();
      dom.deleteError.hidden = true;
      dom.deleteForm.reset();
      dom.deleteDialog.showModal();
      requestAnimationFrame(() => dom.deletePassword.focus());
    });
    dom.sessionsBlock.addEventListener('toggle', () => {
      if (dom.sessionsBlock.open) loadSessions();
    });

    dom.sessionsList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-session-id]');
      if (!button) return;
      button.disabled = true;
      const response = await api(`/api/v1/auth/sessions/${encodeURIComponent(button.dataset.sessionId)}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        showToast('该设备已退出登录');
        loadSessions();
      } else {
        showToast(apiError(response, '操作失败'));
        button.disabled = false;
      }
    });

    dom.mergeDialog.addEventListener('click', (event) => {
      const button = event.target.closest('[data-merge]');
      if (button) settleMerge(button.dataset.merge);
    });
    dom.mergeDialog.addEventListener('close', () => {
      if (state.mergeResolver) settleMerge('later');
    });

    dom.confirmOk.addEventListener('click', () => settleConfirm(true));
    dom.confirmCancel.addEventListener('click', () => settleConfirm(false));
    dom.confirmDialog.addEventListener('close', () => {
      const resolve = getConfirmResolver();
      if (!resolve) return;
      setConfirmResolver(null);
      resolve(false);
    });

    dom.toastAction.addEventListener('click', () => {
      const handler = getToastActionHandler();
      hideToast();
      if (handler) handler();
    });

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;

      const closeTrigger = event.target.closest('[data-close-dialog]');
      if (closeTrigger) {
        closeTrigger.closest('dialog')?.close();
        return;
      }

      if (state.engineMenuOpen && !dom.engine.contains(event.target)) {
        setEngineMenu(false);
      }
    });

    bindDialogShells();

    function shortcutMatches(event, shortcut) {
      const parts = String(shortcut || '')
        .split('+')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
      const key = parts.pop();
      if (!key) return false;
      const needAlt = parts.includes('alt');
      const needCtrl = parts.includes('ctrl') || parts.includes('control');
      const needMeta = parts.includes('meta') || parts.includes('cmd');
      const needShift = parts.includes('shift');
      return (
        event.altKey === needAlt &&
        event.ctrlKey === needCtrl &&
        event.metaKey === needMeta &&
        event.shiftKey === needShift &&
        String(event.key).toLowerCase() === key
      );
    }

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const isTyping = isTypingTarget(target);

      // 隐私空间打开时，普通快捷键不生效，避免把搜索框等焦点抢到遮罩后面。
      if (globalThis.QingdhPrivacy && QingdhPrivacy.isOpen()) return;

      // 隐私模块按需加载：快捷键先于模块初始化时由这里接管一次。
      if (
        !globalThis.QingdhPrivacy &&
        !isTyping &&
        !isDialogOpen() &&
        shortcutMatches(event, prefs.privacyShortcut)
      ) {
        event.preventDefault();
        withOptionalModule('QingdhPrivacy', () => QingdhPrivacy.requestOpen());
        return;
      }

      if (state.drawerOpen && !isDialogOpen()) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeDrawer();
          return;
        }
        trapDrawerFocus(event);
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'Period') {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        withOptionalModule('QingdhMemo', () => QingdhMemo.quickCapture());
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        withOptionalModule('QingdhCommandPalette', () => QingdhCommandPalette.open());
        return;
      }

      if (
        event.key === '/' &&
        !isTyping &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isDialogOpen()
      ) {
        event.preventDefault();
        focusSearch();
        return;
      }

      if (
        event.key === 'Escape' &&
        globalThis.QingdhMemo &&
        QingdhMemo.isOpen() &&
        !isTyping &&
        !isDialogOpen()
      ) {
        QingdhMemo.close();
        return;
      }

      if (event.key === 'Escape' && state.editing && !isTyping && !isDialogOpen() && !state.engineMenuOpen) {
        setEditing(false);
      }
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (prefs.theme === 'auto') applyTheme();
    });

    function autoSyncFromFocus() {
      if (!sync.user || sync.inFlight || sync.status === 'auth') return;
      if (!focusSyncAllowed(sync.lastAutoSyncAt, now())) return;
      sync.lastAutoSyncAt = now();
      syncNow();
    }

    window.addEventListener('online', () => {
      sync.online = true;
      if (sync.user) {
        setStatus(sync.dirty ? 'dirty' : 'syncing');
        sync.lastAutoSyncAt = now();
        syncNow();
      }
    });

    window.addEventListener('offline', () => {
      sync.online = false;
      if (sync.user) setStatus('offline');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        restartClock();
        if (globalThis.QingdhMemo) QingdhMemo.checkReminders();
      }
      if (document.visibilityState === 'visible') autoSyncFromFocus();
    });

    window.addEventListener('focus', autoSyncFromFocus);

    }

    return { bindEvents };
  }

  return { create };
});
