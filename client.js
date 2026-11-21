/**
 * dsh-session-revenant — Client half.
 *
 * Two pieces of UI, both plain DOM for their dialogs:
 *
 *   1. a row in the sidebar Session menu ("⋯" on a session) that deletes the
 *      session, with a confirmation dialog carrying Yes / No and a "create a
 *      backup" checkbox;
 *   2. a restart action beside Settings at the sidebar foot, because the
 *      desktop application keeps its own restart entry in a native [应用] menu
 *      that the Web UI cannot reach.
 *
 * A dialog is appended to `document.body`, NOT rendered inside its trigger:
 * closing the session menu unmounts the menu item's React tree (the popover is
 * removed), so a dialog rendered inside it would disappear with the menu.
 *
 * The Host half owns the deletion, the measurement and the restart; the Client
 * only collects the decision and POSTs it. After a successful delete the page
 * reloads so every derived view (search, archive list, projections) starts from
 * the post-delete state instead of a stale snapshot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-revenant',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SLOT = 'sidebar.workspaces.session.menu.item'
    const FOOTER_SLOT = 'sidebar.footer.action'
    const SETTINGS_SLOT = 'plugins.bundle.config'
    const SETTINGS_KEY = 'dsh-session-revenant'
    const SETTINGS_ID = 'dsh-session-revenant-settings'
    const ROUTE_SEGMENT = '/dsh-session-revenant'
    const ITEM_ID = 'dsh-session-revenant'
    const ITEM_ORDER = 700
    const RESTART_ID = 'dsh-session-revenant-restart'
    const RESTART_ORDER = 50
    const RELOAD_ID = 'dsh-session-revenant-reload'
    const RELOAD_ORDER = 40
    const STYLE_ID = 'dsh-session-revenant-style'

    const CSS = `
.dsh-session-revenant-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer;white-space:nowrap}
.dsh-session-revenant-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-session-revenant-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-session-revenant-item:disabled{opacity:.6;cursor:default}
.dsh-session-revenant-item .dsh-session-revenant-glyph{display:inline-flex;width:14px;height:14px;flex:0 0 14px;color:var(--dsw-alias-state-error-primary)}
.dsh-session-revenant-item .dsh-session-revenant-glyph svg{display:block;width:14px;height:14px}
.dsh-session-revenant-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45);font-family:inherit}
.dsh-session-revenant-dialog{width:min(440px,100%);box-sizing:border-box;padding:18px 18px 16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1c1f26);color:var(--dsw-alias-label-primary,#e8eaed);box-shadow:0 18px 48px rgba(0,0,0,.45);font-size:13px;line-height:1.6}
.dsh-session-revenant-title{font-size:15px;font-weight:600;line-height:1.45}
.dsh-session-revenant-body{margin-top:8px;word-break:break-word;text-wrap:pretty}
.dsh-session-revenant-size{margin-top:12px;padding:10px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.25);font-size:12.5px;line-height:1.6}
.dsh-session-revenant-size-row{display:flex;justify-content:space-between;gap:12px}
.dsh-session-revenant-size-row + .dsh-session-revenant-size-row{margin-top:2px}
.dsh-session-revenant-size-label{opacity:.72}
.dsh-session-revenant-size-value{font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-session-revenant-size-note{margin-top:4px;font-size:12px;opacity:.62}
.dsh-session-revenant-check{display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));cursor:pointer;user-select:none}
.dsh-session-revenant-check input{flex:0 0 auto;margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}
.dsh-session-revenant-hint{margin-top:8px;font-size:12px;line-height:1.55;opacity:.75;text-wrap:balance}
.dsh-session-revenant-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.dsh-session-revenant-btn{min-width:76px;padding:7px 16px;border-radius:8px;font:inherit;font-size:13px;line-height:1.4;cursor:pointer;border:1px solid transparent;transition:opacity .12s ease}
.dsh-session-revenant-btn:disabled{opacity:.55;cursor:default}
.dsh-session-revenant-btn-cancel{border-color:rgba(128,128,128,.4);background:transparent;color:inherit}
.dsh-session-revenant-btn-cancel:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}
.dsh-session-revenant-btn-ok{background:#d64545;color:#fff}
.dsh-session-revenant-btn-ok:hover:not(:disabled){opacity:.88}
.dsh-session-revenant-btn-restart{background:#4d6bfe;color:#fff}
.dsh-session-revenant-btn-restart:hover:not(:disabled){opacity:.88}
.dsh-session-revenant-foot{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;box-sizing:border-box;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a8adba);font:inherit;font-size:12.5px;line-height:1.4;cursor:pointer;white-space:nowrap}
.dsh-session-revenant-foot:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-session-revenant-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-session-revenant-foot:disabled{opacity:.55;cursor:default}
.dsh-session-revenant-foot-rail{padding:8px 0}
/* A column of one: the sidebar footer is a horizontal flex row, so once this
   plugin contributes two controls the row would split them side by side. The
   slot node itself uses display: contents, so the rule has to reach its parent. */
:has(> [data-slot="sidebar.footer.action"] .dsh-session-revenant-foot){flex-direction:column;gap:2px}
.dsh-session-revenant-foot svg{display:block;width:16px;height:16px}
.dsh-session-revenant-spin{animation:dsh-session-revenant-spin 900ms linear infinite}
@keyframes dsh-session-revenant-spin{to{transform:rotate(360deg)}}
.dsh-session-revenant-config{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.55}
.dsh-session-revenant-config-summary{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a8adba)}
.dsh-session-revenant-config-heading{font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#a8adba)}
.dsh-session-revenant-config-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.25);cursor:pointer}
.dsh-session-revenant-config-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}
.dsh-session-revenant-config-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-session-revenant-config-title{font-weight:500}
.dsh-session-revenant-config-hint{font-size:12px;line-height:1.5;opacity:.7;text-wrap:pretty}
.dsh-session-revenant-config-check{flex:0 0 auto;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}
.dsh-session-revenant-config-error{font-size:12px;line-height:1.5;color:#e06666}
.dsh-session-revenant-config-path{display:flex;align-items:center;gap:8px}
.dsh-session-revenant-config-input{flex:1 1 auto;min-width:0;padding:6px 10px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:inherit;font-size:12.5px;line-height:1.4}
.dsh-session-revenant-config-input:disabled{opacity:.6}
.dsh-session-revenant-backups-legacy{font-size:11px;opacity:.7}
.dsh-session-revenant-backups{display:flex;flex-direction:column;gap:8px}
.dsh-session-revenant-backups-empty{padding:10px 12px;border-radius:8px;border:1px dashed rgba(128,128,128,.35);font-size:12.5px;line-height:1.5;opacity:.8;text-wrap:pretty}
.dsh-session-revenant-backups-list{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto}
.dsh-session-revenant-backups-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.25)}
.dsh-session-revenant-backups-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-session-revenant-backups-title{font-size:12.5px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-session-revenant-backups-meta{font-size:11.5px;line-height:1.5;opacity:.65}
.dsh-session-revenant-backups-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.dsh-session-revenant-backups-btn{flex:0 0 auto;min-width:64px;padding:5px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:inherit;font-size:12.5px;line-height:1.4;cursor:pointer}
.dsh-session-revenant-backups-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}
.dsh-session-revenant-backups-btn-remove{min-width:52px;border-color:rgba(214,69,69,.55);color:#e06666}
.dsh-session-revenant-backups-btn-remove:hover:not(:disabled){background:rgba(214,69,69,.12)}
.dsh-session-revenant-backups-btn:disabled{opacity:.5;cursor:default}
.dsh-session-revenant-backups-note{font-size:12px;line-height:1.5;text-wrap:pretty}
.dsh-session-revenant-backups-note-ok{color:#3fae6a}
.dsh-session-revenant-backups-note-bad{color:#e06666}
`

    let translate = (key) => key

    /** Locale text with a readable fallback, never undefined. */
    function text(key) {
      let value
      try {
        value = translate(key)
      } catch {
        value = undefined
      }
      return typeof value === 'string' && value !== '' ? value : key
    }

    /**
     * The message a failed response carries, translated when the Host sent a code
     * this build knows. The English message stays as the fallback so an unknown
     * code still says something useful.
     */
    function failureText(payload, response) {
      const status = response && typeof response.status === 'number' ? response.status : 0
      const statusText = response && response.statusText ? ` ${response.statusText}` : ''
      const message = (payload && payload.error) || `${status}${statusText}`
      const code = payload && typeof payload.code === 'string' ? payload.code : ''
      if (code !== '') {
        const key = `error.code.${code}`
        const translated = text(key)
        if (translated !== key) return translated.replace('{detail}', message)
      }
      return message
    }

    function normalizeBase() {
      try {
        return new URL(document.baseURI).pathname.replace(/\/+$/, '')
      } catch {
        return ''
      }
    }

    function deleteUrl() {
      return `${normalizeBase()}${ROUTE_SEGMENT}/delete`
    }

    function sizeUrl() {
      return `${normalizeBase()}${ROUTE_SEGMENT}/size`
    }

    function restartUrl() {
      return `${normalizeBase()}${ROUTE_SEGMENT}/restart`
    }

    function configUrl() {
      return `${normalizeBase()}${ROUTE_SEGMENT}/config`
    }

    function backupsUrl() {
      return `${normalizeBase()}${ROUTE_SEGMENT}/backups`
    }

    function restoreUrl() {
      return `${normalizeBase()}${ROUTE_SEGMENT}/restore`
    }

    function discardUrl() {
      return `${normalizeBase()}${ROUTE_SEGMENT}/discard`
    }

    /** Preferences mirrored from the Host half; see `loadSettings`. */
    let settings = {
      restartAction: true,
      reloadAction: true,
      backupDir: '',
      autoClean: false,
      backupRoot: '',
      defaultBackupRoot: '',
      loaded: false,
    }
    const settingsListeners = new Set()

    function setSettings(patch) {
      settings = { ...settings, ...patch }
      for (const listener of settingsListeners) listener()
    }

    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    }

    function settingsSnapshot() {
      return settings
    }

    /** The live preferences, re-rendering the caller when they change. */
    function useSettings() {
      return React.useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsSnapshot)
    }

    /**
     * Read the preferences once per page load. Failure keeps the defaults, so a
     * Host that cannot answer still leaves both controls usable.
     */
    async function loadSettings() {
      try {
        const response = await fetch(configUrl(), { headers: { accept: 'application/json' } })
        const payload = await response.json()
        if (!response.ok || !payload || payload.ok !== true || typeof payload.config !== 'object') return
        setSettings({
          restartAction: payload.config.restartAction !== false,
          reloadAction: payload.config.reloadAction !== false,
          autoClean: payload.config.autoClean === true,
          backupDir: typeof payload.config.backupDir === 'string' ? payload.config.backupDir : '',
          backupRoot: typeof payload.backupRoot === 'string' ? payload.backupRoot : settings.backupRoot,
          defaultBackupRoot: typeof payload.defaultBackupRoot === 'string'
            ? payload.defaultBackupRoot
            : settings.defaultBackupRoot,
          loaded: true,
        })
      } catch {
        setSettings({ loaded: true })
      }
    }

    /**
     * Persist one preference and mirror the Host's answer, so the sidebar and the
     * plugin page never disagree about what is on disk.
     * @param patch - preference fields to change.
     * @returns whether the Host accepted the change.
     */
    async function saveSettings(patch) {
      const response = await fetch(configUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json()
      if (!response.ok || !payload || payload.ok !== true || typeof payload.config !== 'object') {
        throw new Error(failureText(payload, response))
      }
      setSettings({
        restartAction: payload.config.restartAction !== false,
        reloadAction: payload.config.reloadAction !== false,
        autoClean: payload.config.autoClean === true,
        loaded: true,
      })
      return true
    }

    function shortId(sessionId) {
      const tail = String(sessionId).replace(/^session-/, '')
      return tail.slice(0, 8)
    }

    /** Human byte size, e.g. `1.4 MB`. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      const digits = value >= 100 ? 0 : 1
      return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[index]}`
    }

    /** Ask the Host how much space this session occupies. */
    function querySize(sessionId) {
      return fetch(sizeUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).then(async (response) => {
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok || !payload || payload.ok !== true) {
          const detail = failureText(payload, response)
          throw new Error(detail)
        }
        return payload
      })
    }

    /**
     * Show the confirmation dialog as a detached DOM subtree on document.body.
     * @param options.title - session title shown in the question.
     * @param options.sessionId - session being deleted; also used to measure it.
     * @param options.onConfirm - called with the checkbox value; may return a
     *   promise. Rejections are shown and re-enable the dialog.
     * @returns a handle with `close()`.
     */
    function showDeleteDialog(options) {
      const { title, sessionId, onConfirm } = options

      const overlay = document.createElement('div')
      overlay.className = 'dsh-session-revenant-overlay'

      const dialog = document.createElement('div')
      dialog.className = 'dsh-session-revenant-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('aria-label', text('dialog.title'))

      const heading = document.createElement('div')
      heading.className = 'dsh-session-revenant-title'
      heading.textContent = text('dialog.title')

      const body = document.createElement('div')
      body.className = 'dsh-session-revenant-body'
      body.textContent = text('dialog.body').replace('{title}', String(title))

      // Live size readout: filled by the async measurement below.
      const sizeBox = document.createElement('div')
      sizeBox.className = 'dsh-session-revenant-size'
      const sizeSessionRow = document.createElement('div')
      sizeSessionRow.className = 'dsh-session-revenant-size-row'
      const sizeSessionLabel = document.createElement('span')
      sizeSessionLabel.className = 'dsh-session-revenant-size-label'
      sizeSessionLabel.textContent = text('size.label.session')
      const sizeSessionValue = document.createElement('span')
      sizeSessionValue.className = 'dsh-session-revenant-size-value'
      sizeSessionValue.textContent = text('size.loading')
      sizeSessionRow.append(sizeSessionLabel, sizeSessionValue)

      const sizeBackupRow = document.createElement('div')
      sizeBackupRow.className = 'dsh-session-revenant-size-row'
      const sizeBackupLabel = document.createElement('span')
      sizeBackupLabel.className = 'dsh-session-revenant-size-label'
      sizeBackupLabel.textContent = text('size.label.backup')
      const sizeBackupValue = document.createElement('span')
      sizeBackupValue.className = 'dsh-session-revenant-size-value'
      sizeBackupValue.textContent = text('size.loading')
      sizeBackupRow.append(sizeBackupLabel, sizeBackupValue)

      const sizeNote = document.createElement('div')
      sizeNote.className = 'dsh-session-revenant-size-note'
      sizeBox.append(sizeSessionRow, sizeBackupRow, sizeNote)

      const check = document.createElement('label')
      check.className = 'dsh-session-revenant-check'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = true
      const checkLabel = document.createElement('span')
      checkLabel.textContent = text('dialog.backup')
      check.append(box, checkLabel)

      const hint = document.createElement('div')
      hint.className = 'dsh-session-revenant-hint'

      let measured = null
      let measuredFailed = false

      function renderSize() {
        if (measuredFailed) {
          sizeSessionValue.textContent = text('size.failed')
          sizeBackupValue.textContent = text('size.failed')
          sizeNote.textContent = ''
          return
        }
        if (measured === null) {
          sizeSessionValue.textContent = text('size.loading')
          sizeBackupValue.textContent = text('size.loading')
          sizeNote.textContent = ''
          return
        }
        sizeSessionValue.textContent = String(text('size.session.value'))
          .replace('{size}', formatBytes(measured.sessionBytes))
          .replace('{files}', String(measured.files))
        if (box.checked) {
          sizeBackupValue.textContent = formatBytes(measured.backupBytes)
          sizeNote.textContent = text('size.note.backup')
        } else {
          sizeBackupValue.textContent = text('size.none')
          sizeNote.textContent = text('size.note.purge')
        }
      }

      function renderHint() {
        hint.textContent = box.checked ? text('dialog.hint.backup') : text('dialog.hint.purge')
      }

      const syncCheckbox = () => {
        renderHint()
        renderSize()
      }
      box.addEventListener('change', syncCheckbox)

      renderHint()
      renderSize()

      querySize(sessionId)
        .then((report) => {
          measured = {
            sessionBytes: Number(report.sessionBytes) || 0,
            files: Number(report.files) || 0,
            backupBytes: Number(report.backupBytes) || 0,
          }
          renderSize()
        })
        .catch(() => {
          measuredFailed = true
          renderSize()
        })

      const actions = document.createElement('div')
      actions.className = 'dsh-session-revenant-actions'

      const noButton = document.createElement('button')
      noButton.type = 'button'
      noButton.className = 'dsh-session-revenant-btn dsh-session-revenant-btn-cancel'
      noButton.textContent = text('dialog.no')

      const yesButton = document.createElement('button')
      yesButton.type = 'button'
      yesButton.className = 'dsh-session-revenant-btn dsh-session-revenant-btn-ok'
      yesButton.textContent = text('dialog.yes')

      let busy = false

      function close() {
        document.removeEventListener('keydown', onKey)
        overlay.remove()
      }

      function onKey(event) {
        if (event.key === 'Escape' && !busy) close()
      }

      noButton.addEventListener('click', () => {
        if (!busy) close()
      })

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay && !busy) close()
      })

      yesButton.addEventListener('click', () => {
        if (busy) return
        busy = true
        yesButton.disabled = true
        noButton.disabled = true
        box.disabled = true
        yesButton.textContent = text('action.deleting')
        let job
        try {
          job = Promise.resolve(onConfirm(box.checked))
        } catch (error) {
          job = Promise.reject(error)
        }
        job.catch((error) => {
          busy = false
          yesButton.disabled = false
          noButton.disabled = false
          box.disabled = false
          yesButton.textContent = text('dialog.yes')
          window.alert(`${text('error.failed')}\n${error instanceof Error ? error.message : String(error)}`)
        })
      })

      actions.append(noButton, yesButton)
      dialog.append(heading, body, sizeBox, check, hint, actions)
      overlay.appendChild(dialog)
      document.body.appendChild(overlay)
      document.addEventListener('keydown', onKey)

      return { close }
    }

    /**
     * A minimal confirmation dialog, plain DOM on `document.body` so it survives
     * the trigger re-rendering or unmounting. The confirm button stays disabled
     * while the action runs, so a slow Host cannot be asked twice.
     * @param options - title, body, hint, confirmLabel, cancelLabel, danger, onConfirm.
     * @returns `{ close }`.
     */
    function showConfirmDialog(options) {
      const overlay = document.createElement('div')
      overlay.className = 'dsh-session-revenant-overlay'

      const dialog = document.createElement('div')
      dialog.className = 'dsh-session-revenant-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')

      const heading = document.createElement('div')
      heading.className = 'dsh-session-revenant-title'
      heading.textContent = options.title
      dialog.appendChild(heading)

      if (options.body) {
        const body = document.createElement('div')
        body.className = 'dsh-session-revenant-body'
        body.textContent = options.body
        dialog.appendChild(body)
      }

      if (options.hint) {
        const hint = document.createElement('div')
        hint.className = 'dsh-session-revenant-hint'
        hint.textContent = options.hint
        dialog.appendChild(hint)
      }

      const actions = document.createElement('div')
      actions.className = 'dsh-session-revenant-actions'

      const noButton = document.createElement('button')
      noButton.type = 'button'
      noButton.className = 'dsh-session-revenant-btn dsh-session-revenant-btn-cancel'
      noButton.textContent = options.cancelLabel || text('dialog.no')

      const yesButton = document.createElement('button')
      yesButton.type = 'button'
      yesButton.className = `dsh-session-revenant-btn ${options.danger ? 'dsh-session-revenant-btn-ok' : 'dsh-session-revenant-btn-restart'}`
      yesButton.textContent = options.confirmLabel || text('dialog.yes')

      actions.append(noButton, yesButton)
      dialog.appendChild(actions)
      overlay.appendChild(dialog)

      let busy = false

      function close() {
        document.removeEventListener('keydown', onKey)
        overlay.remove()
      }

      function setBusy(next) {
        busy = next
        noButton.disabled = next
        yesButton.disabled = next
      }

      function onKey(event) {
        if (event.key === 'Escape' && !busy) close()
      }

      noButton.addEventListener('click', () => {
        if (!busy) close()
      })
      overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay && !busy) close()
      })
      yesButton.addEventListener('click', () => {
        if (busy) return
        setBusy(true)
        Promise.resolve()
          .then(() => options.onConfirm())
          .then(() => {
            // A confirmation that started work the page cannot wait for (the
            // window is about to close) keeps the dialog open and says so. Every
            // other confirmation has finished its work by now, so the dialog goes
            // away — a dialog left behind looks like a hang.
            if (options.keepOpen !== true) {
              close()
              return
            }
            if (!options.busyLabel) return
            yesButton.textContent = options.busyLabel
            noButton.hidden = true
          })
          .catch((error) => {
            setBusy(false)
            window.alert(`${text('error.action')} ${error instanceof Error ? error.message : String(error)}`)
          })
      })
      document.addEventListener('keydown', onKey)
      document.body.appendChild(overlay)
      window.setTimeout(() => yesButton.focus(), 0)

      return { close }
    }

    /** One row-menu entry: close the menu, then show the detached dialog. */
    function DeleteSessionItem(props) {
      const sessionId = props && props.sessionId
      const displayTitle = props && props.displayTitle
      const useMenuOpenState = props && props.useMenuOpenState
      const setMenuOpen = typeof useMenuOpenState === 'function'
        ? useMenuOpenState()[1]
        : () => {}

      const title = displayTitle || shortId(sessionId)

      const onClick = () => {
        setMenuOpen(false)
        showDeleteDialog({
          title,
          sessionId,
          onConfirm: (withBackup) => fetch(deleteUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, backup: Boolean(withBackup) }),
          }).then(async (response) => {
            let payload = null
            try {
              payload = await response.json()
            } catch {
              payload = null
            }
            if (!response.ok || !payload || payload.ok !== true) {
              const detail = failureText(payload, response)
              throw new Error(detail)
            }
            window.location.reload()
          }),
        })
      }

      const glyph = h('span', { className: 'dsh-session-revenant-glyph', 'aria-hidden': true },
        h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
          h('path', { d: 'M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M4.4 4.5l.6 8c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9l.6-8' }),
        ),
      )

      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-session-revenant-item',
        onClick,
      }, glyph, h('span', null, text('action.delete')))
    }

    /**
     * The sidebar-foot reload control, one step above the restart one. It only
     * rebuilds the page, so it is instant and has nothing to confirm: a stale
     * session list is what most people actually want to fix.
     */
    function ReloadPageAction(props) {
      const prefs = useSettings()
      const wide = !(props && props.wide === false)
      const [busy, setBusy] = React.useState(false)

      // The plugin page can switch this control off; rendering nothing is the
      // whole of "hidden", the registration stays in place for a later toggle.
      if (!prefs.reloadAction) return null

      const onClick = () => {
        if (busy) return
        setBusy(true)
        window.location.reload()
      }

      const glyph = h('svg', {
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: busy ? 'dsh-session-revenant-spin' : undefined,
        'aria-hidden': true,
      },
        h('path', { d: 'M2.4 8a5.6 5.6 0 1 1 1.9 4.2' }),
        h('path', { d: 'M2.3 13.8v-3.1h3.1' }),
      )

      return h('button', {
        type: 'button',
        className: `dsh-session-revenant-foot${wide ? '' : ' dsh-session-revenant-foot-rail'}`,
        title: text('reload.label'),
        'aria-label': text('reload.label'),
        disabled: busy,
        onClick,
      }, glyph, wide ? h('span', null, text('reload.label')) : null)
    }

    /**
     * The sidebar-foot restart control: an icon in the 56px rail, icon plus text
     * when the sidebar is wide.
     */
    function RestartAppAction(props) {
      const prefs = useSettings()
      const wide = !(props && props.wide === false)
      const [busy, setBusy] = React.useState(false)

      // The plugin page can switch this control off; rendering nothing is the
      // whole of "hidden", the registration stays in place for a later toggle.
      if (!prefs.restartAction) return null

      const onClick = () => {
        showConfirmDialog({
          title: text('restart.title'),
          body: text('restart.body'),
          hint: text('restart.hint'),
          confirmLabel: text('restart.yes'),
          busyLabel: text('restart.waiting'),
          cancelLabel: text('dialog.no'),
          keepOpen: true,
          onConfirm: () => fetch(restartUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }).then(async (response) => {
            let payload = null
            try {
              payload = await response.json()
            } catch {
              payload = null
            }
            if (!response.ok || !payload || payload.ok !== true) {
              const detail = failureText(payload, response)
              throw new Error(detail)
            }
            // The window is about to close itself: no reload, the wheel just
            // spins. The timeout is only a fallback for a restart that never
            // lands, so the page does not stay stuck in the busy state.
            setBusy(true)
            window.setTimeout(() => { window.location.reload() }, 12000)
          }),
        })
      }

      const glyph = h('svg', {
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: busy ? 'dsh-session-revenant-spin' : undefined,
        'aria-hidden': true,
      },
        h('path', { d: 'M13.6 8a5.6 5.6 0 1 1-1.9-4.2' }),
        h('path', { d: 'M13.7 2.2v3.1h-3.1' }),
      )

      return h('button', {
        type: 'button',
        className: `dsh-session-revenant-foot${wide ? '' : ' dsh-session-revenant-foot-rail'}`,
        title: text('restart.label'),
        'aria-label': text('restart.label'),
        disabled: busy,
        onClick,
      }, glyph, wide ? h('span', null, text('restart.label')) : null)
    }

    /** `2026-11-21 20:41` for a backup timestamp. */
    function formatWhen(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const when = new Date(iso)
      if (Number.isNaN(when.getTime())) return iso
      const pad = (value) => String(value).padStart(2, '0')
      return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
    }

    /**
     * The block above the switches: whatever sits in the backup directory, and a
     * restore control for the copies that carry a manifest. A copy without one
     * is listed but not offered for restore — guessing where it belongs is worse
     * than telling the user to copy it back by hand.
     */
    function BackupsPanel() {
      const [state, setState] = React.useState({ loading: true, rows: [], error: false })
      const [pending, setPending] = React.useState(null)
      const [discarding, setDiscarding] = React.useState(null)
      const [note, setNote] = React.useState(null)

      const load = React.useCallback(() => {
        let alive = true
        setState((previous) => ({ loading: true, rows: previous.rows, error: false }))
        fetch(backupsUrl(), { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok !== true) {
              throw new Error(failureText(payload, response))
            }
            return payload
          })
          .then((payload) => {
            if (!alive) return
            setState({
              loading: false,
              rows: Array.isArray(payload.backups) ? payload.backups : [],
              error: false,
            })
          })
          .catch(() => {
            if (alive) setState({ loading: false, rows: [], error: true })
          })
        return () => { alive = false }
      }, [])

      React.useEffect(load, [load])

      const onRestore = (row) => {
        if (pending !== null) return
        setPending(row.id)
        setNote(null)
        fetch(restoreUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ backup: row.id }),
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok !== true) {
              throw new Error(failureText(payload, response))
            }
            return payload
          })
          .then((payload) => {
            const problems = Array.isArray(payload.problems) ? payload.problems : []
            load()
            if (problems.length > 0) {
              // The files are back but a sidebar state did not stick; say which
              // one instead of reloading the reason out of sight.
              setNote({ kind: 'bad', text: text('backups.partial') + problems.join('; ') })
              return
            }
            setNote({ kind: 'ok', text: text('backups.restored') })
            // The restored rows only show up after a reload; do it for the user
            // instead of asking them to restart the whole application for it.
            window.setTimeout(() => { window.location.reload() }, 900)
          })
          .catch((error) => {
            const reason = (error && error.message) || ''
            setNote({ kind: 'bad', text: text('backups.restoreFailed') + reason })
          })
          .finally(() => { setPending(null) })
      }

      /**
       * Deleting a backup is the one action here that cannot be undone, so it
       * goes through the same plain-DOM confirm dialog as the session delete and
       * names the bytes it is about to free.
       */
      const onDiscard = (row) => {
        if (pending !== null || discarding !== null) return
        const id = String(row.id || '')
        const title = typeof row.title === 'string' && row.title !== '' ? row.title : null
        const label = title ?? (row.sessionId ? `session ${shortId(row.sessionId)}` : id)
        showConfirmDialog({
          title: text('backups.removeTitle'),
          body: text('backups.removeBody')
            .replace('{label}', label)
            .replace('{size}', formatBytes(row.bytes)),
          hint: text('backups.removeHint'),
          confirmLabel: text('backups.remove'),
          busyLabel: text('backups.removing'),
          cancelLabel: text('dialog.no'),
          onConfirm: () => {
            setDiscarding(id)
            setNote(null)
            return fetch(discardUrl(), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ backup: id }),
              // Never leave the dialog greyed out forever if the Host stops
              // answering mid-request.
              signal: AbortSignal.timeout(20000),
            }).then(async (response) => {
              const payload = await response.json().catch(() => null)
              if (!response.ok || !payload || payload.ok !== true) {
                const detail = failureText(payload, response)
                throw new Error(detail)
              }
              setNote({ kind: 'ok', text: text('backups.removed') })
              setState((previous) => ({ ...previous, rows: previous.rows.filter((item) => item.id !== id) }))
              load()
            }).catch((error) => {
              const reason = (error && error.message) || ''
              setNote({ kind: 'bad', text: text('backups.removeFailed') + reason })
              throw error
            }).finally(() => { setDiscarding(null) })
          },
        })
      }

      let body
      if (state.error === true) {
        body = h('div', { className: 'dsh-session-revenant-backups-empty' }, text('backups.failed'))
      } else if (state.loading === true && state.rows.length === 0) {
        body = h('div', { className: 'dsh-session-revenant-backups-empty' }, text('backups.loading'))
      } else if (state.rows.length === 0) {
        body = h('div', { className: 'dsh-session-revenant-backups-empty' }, text('backups.empty'))
      } else {
        body = h('div', { className: 'dsh-session-revenant-backups-list' }, state.rows.map((row) => {
          const restorable = row.restorable === true
          const id = String(row.id || '')
          const title = typeof row.title === 'string' && row.title !== '' ? row.title : null
          const label = title ?? (row.sessionId ? `session ${shortId(row.sessionId)}` : id)
          const meta = [
            title !== null && row.sessionId ? `session ${shortId(row.sessionId)}` : '',
            formatWhen(row.createdAt),
            formatBytes(row.bytes),
            restorable ? '' : text('backups.noManifest'),
            row.legacy === true ? text('backups.legacy') : '',
          ].filter((part) => part !== '').join(' · ')
          return h('div', { className: 'dsh-session-revenant-backups-row', key: id },
            h('div', { className: 'dsh-session-revenant-backups-main' },
              h('div', { className: 'dsh-session-revenant-backups-title', title: id }, label),
              h('div', { className: 'dsh-session-revenant-backups-meta' }, meta)),
            h('div', { className: 'dsh-session-revenant-backups-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-session-revenant-backups-btn',
                disabled: restorable === false || pending !== null || discarding !== null,
                title: restorable ? text('backups.restore') : text('backups.noManifest'),
                onClick: () => { onRestore(row) },
              }, pending === id ? text('backups.restoring') : text('backups.restore')),
              h('button', {
                type: 'button',
                className: 'dsh-session-revenant-backups-btn dsh-session-revenant-backups-btn-remove',
                disabled: pending !== null || discarding !== null,
                title: text('backups.remove'),
                onClick: () => { onDiscard(row) },
              }, discarding === id ? text('backups.removing') : text('backups.remove'))))
        }))
      }

      return h('div', { className: 'dsh-session-revenant-backups' },
        h('div', { className: 'dsh-session-revenant-config-heading' }, text('backups.heading')),
        body,
        note === null
          ? null
          : h('div', {
            className: `dsh-session-revenant-backups-note dsh-session-revenant-backups-note-${note.kind}`,
          }, note.text))
    }

    /**
     * The bundle's row on its plugin page: one switch that shows or hides the
     * sidebar restart control. Written straight through to the Host half, so the
     * sidebar and this page cannot drift apart.
     */
    function RevenantSettings(props) {
      const prefs = useSettings()
      const view = props && props.view === 'page' ? 'page' : 'summary'
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const [draft, setDraft] = React.useState('')

      React.useEffect(() => {
        setDraft(typeof prefs.backupDir === 'string' ? prefs.backupDir : '')
      }, [prefs.backupDir])

      const onToggle = (patch) => {
        if (busy) return
        setBusy(true)
        setFailed(false)
        saveSettings(patch)
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }

      const onSaveDir = () => {
        if (busy) return
        setBusy(true)
        setFailed(false)
        saveSettings({ backupDir: draft.trim() })
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }

      if (view === 'summary') {
        const shown = [
          prefs.reloadAction ? text('settings.summary.reload.on') : text('settings.summary.reload.off'),
          prefs.restartAction ? text('settings.summary.on') : text('settings.summary.off'),
        ]
        return h('div', { className: 'dsh-session-revenant-config-summary' }, shown.join(' · '))
      }

      const dirty = draft.trim() !== (typeof prefs.backupDir === 'string' ? prefs.backupDir : '')
      const effective = prefs.backupRoot || prefs.defaultBackupRoot || ''

      return h('div', { className: 'dsh-session-revenant-config' },
        h(BackupsPanel),
        h('div', { className: 'dsh-session-revenant-config-heading' }, text('settings.heading')),
        h('div', { className: 'dsh-session-revenant-config-path' },
          h('input', {
            type: 'text',
            className: 'dsh-session-revenant-config-input',
            value: draft,
            spellCheck: false,
            disabled: busy,
            placeholder: prefs.defaultBackupRoot || '',
            'aria-label': text('settings.backupDir.title'),
            onChange: (event) => { setDraft(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Enter') onSaveDir()
            },
          }),
          h('button', {
            type: 'button',
            className: 'dsh-session-revenant-backups-btn',
            disabled: busy || !dirty,
            onClick: onSaveDir,
          }, text('settings.backupDir.save'))),
        h('div', { className: 'dsh-session-revenant-config-hint' },
          text('settings.backupDir.hint').replace('{path}', effective)),
        h('label', { className: 'dsh-session-revenant-config-row' },
          h('span', { className: 'dsh-session-revenant-config-text' },
            h('span', { className: 'dsh-session-revenant-config-title' }, text('settings.reload.title')),
            h('span', { className: 'dsh-session-revenant-config-hint' }, text('settings.reload.hint'))),
          h('input', {
            type: 'checkbox',
            className: 'dsh-session-revenant-config-check',
            checked: prefs.reloadAction,
            disabled: busy,
            onChange: () => { onToggle({ reloadAction: !prefs.reloadAction }) },
          })),
        h('label', { className: 'dsh-session-revenant-config-row' },
          h('span', { className: 'dsh-session-revenant-config-text' },
            h('span', { className: 'dsh-session-revenant-config-title' }, text('settings.restart.title')),
            h('span', { className: 'dsh-session-revenant-config-hint' }, text('settings.restart.hint'))),
          h('input', {
            type: 'checkbox',
            className: 'dsh-session-revenant-config-check',
            checked: prefs.restartAction,
            disabled: busy,
            onChange: () => { onToggle({ restartAction: !prefs.restartAction }) },
          })),
        h('label', { className: 'dsh-session-revenant-config-row' },
          h('span', { className: 'dsh-session-revenant-config-text' },
            h('span', { className: 'dsh-session-revenant-config-title' }, text('settings.autoClean.title')),
            h('span', { className: 'dsh-session-revenant-config-hint' }, text('settings.autoClean.hint'))),
          h('input', {
            type: 'checkbox',
            className: 'dsh-session-revenant-config-check',
            checked: prefs.autoClean === true,
            disabled: busy,
            onChange: () => { onToggle({ autoClean: prefs.autoClean !== true }) },
          })),
        failed ? h('div', { className: 'dsh-session-revenant-config-error' }, text('settings.failed')) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.locale.register('dsh-session-revenant', 'en', {
            'action.delete': 'Delete session',
            'action.deleting': 'Deleting…',
            'dialog.title': 'Delete this conversation?',
            'dialog.body': 'Session "{title}" will be removed from this workspace. Do you really want to delete it?',
            'dialog.backup': 'Create a backup of this conversation (can be restored from disk)',
            'dialog.hint.backup': 'A copy is written to the backup directory first; a failed copy aborts the deletion.',
            'dialog.hint.purge': 'No backup is written: the log, projection cache and search index rows are purged for good.',
            'dialog.yes': 'Yes, delete',
            'dialog.no': 'No',
            'error.failed': 'Delete failed:',
            'size.label.session': 'This session',
            'size.label.backup': 'Backup copy',
            'size.loading': 'measuring…',
            'size.failed': 'unavailable',
            'size.files': 'files',
            'size.session.value': '{size} ({files} files)',
            'size.none': 'no backup',
            'size.note.backup': 'The backup holds the conversation log only, without the index cache that can be rebuilt. It stays in the backup directory.',
            'size.note.purge': 'No backup: this space is freed immediately and cannot be recovered.',
            'restart.label': 'Restart app',
            'restart.title': 'Restart DeepSeek Harness?',
            'restart.body': 'The window closes and the application starts again.',
            'restart.hint': 'The answer that is running right now is interrupted; sessions are already saved and come back when the app reopens. The window closes and comes back in front within a few seconds.',
            'restart.yes': 'Restart now',
            'restart.waiting': 'Restarting…',
            'error.action': 'Action failed:',
            'settings.summary.on': 'Restart button shown',
            'settings.summary.off': 'Restart button hidden',
            'settings.heading': 'Settings',
            'settings.reload.title': 'Show the "Reload page" button',
            'settings.reload.hint': 'Adds a control at the sidebar foot; it rebuilds the page in about a second and restarts nothing.',
            'settings.restart.title': 'Show the "Restart app" button',
            'settings.restart.hint': 'Adds a control at the sidebar foot; it closes and relaunches DeepSeek Harness.',
            'settings.autoClean.title': 'Delete backups older than 7 days',
            'settings.autoClean.hint': 'While this is off no backup is ever removed on its own. Backups in the older default folder are never swept.',
            'settings.failed': 'Could not save this setting. Try again.',
            'settings.backupDir.title': 'Backup directory',
            'settings.backupDir.save': 'Save',
            'settings.backupDir.hint': 'Conversations are copied here before deletion. Leave the field empty to use the default. In use: {path}',
            'settings.summary.reload.on': 'Reload button',
            'settings.summary.reload.off': 'No reload button',
            'reload.label': 'Reload page',
            'backups.heading': 'Backups',
            'backups.empty': 'There are no backups in the backup directory yet.',
            'backups.loading': 'Reading backups…',
            'backups.failed': 'Could not read the backup directory.',
            'backups.restore': 'Restore',
            'backups.restoring': 'Restoring…',
            'backups.restored': 'Restored. Reloading the page…',
            'backups.restoreFailed': 'Restore failed: ',
            'backups.partial': 'Restored, but some state did not come back: ',
            'backups.noManifest': 'no manifest, copy back by hand',
            'backups.remove': 'Delete',
            'backups.removing': 'Deleting…',
            'backups.removeTitle': 'Delete this backup?',
            'backups.removeBody': 'The backup of {label} ({size}) is deleted from disk. It cannot be restored afterwards.',
            'backups.removeHint': 'The conversation itself is unaffected; only the backup copy goes away.',
            'backups.removed': 'Backup deleted.',
            'backups.removeFailed': 'Could not delete the backup: ',
            'backups.legacy': 'from the older folder',
            'error.code.failed': 'The Host reported a failure: {detail}',
            'error.code.bad-backup-id': 'That backup name is not valid.',
            'error.code.bad-session-id': 'That session name is not valid.',
            'error.code.manifest-missing': 'This backup carries no manifest, so it cannot be restored automatically.',
            'error.code.invalid-session': 'This backup does not name a valid session.',
            'error.code.session-exists': 'That session already exists; nothing was restored.',
            'error.code.target-exists': 'A restore target already exists, so nothing was copied: {detail}',
            'error.code.nothing-restored': 'Nothing in this backup could be copied back; its files are missing.',
            'error.code.backup-missing': 'That backup is not in the backup directory any more.',
            'error.code.backup-not-directory': 'That entry is not a folder.',
            'error.code.session-not-found': 'That session is not in this profile any more.',
            'error.code.self-delete': 'This is the session serving the request; pick another one.',
            'error.code.restart-unsupported': 'Restarting is only implemented on Windows.',
            'error.code.restart-in-progress': 'A restart is already in progress.',
            'error.code.restart-unavailable': 'This Host does not run inside the desktop app, so it cannot restart.',
            'error.code.restart-helper-failed': 'Could not start the restart helper: {detail}',
            'error.code.body-too-large': 'The request was too large.',
            'error.code.bad-json': 'The request body was not valid JSON.',
            'error.code.method-not-allowed': 'That action does not accept this request method.',
            'error.code.unknown-action': 'Unknown action.',
          })
          ctx.locale.register('dsh-session-revenant', 'zh', {
            'action.delete': '删除会话',
            'action.deleting': '正在删除…',
            'dialog.title': '确定要删除这个对话吗？',
            'dialog.body': '会话「{title}」将从当前工作区移除。确定真的要删除吗？',
            'dialog.backup': '创建此对话的备份（可从备份区恢复）',
            'dialog.hint.backup': '删除前会先把日志、投影缓存和搜索索引条目拷贝到备份目录；拷贝失败则整次删除中止。',
            'dialog.hint.purge': '不创建备份：日志、投影缓存和搜索索引条目会被彻底清除，无法恢复。',
            'dialog.yes': '是，删除',
            'dialog.no': '否',
            'error.failed': '删除失败：',
            'size.label.session': '本会话占用',
            'size.label.backup': '备份副本大小',
            'size.loading': '正在统计…',
            'size.failed': '统计失败',
            'size.files': '个文件',
            'size.session.value': '{size}（{files} 个文件）',
            'size.none': '不创建（0 B）',
            'size.note.backup': '备份只存对话日志，不含可重建的索引缓存，会保留在备份目录里。',
            'size.note.purge': '不创建备份：这些空间立即释放，之后无法恢复。',
            'restart.label': '重启应用',
            'restart.title': '要重启 DeepSeek Harness 吗？',
            'restart.body': '窗口会关闭，然后应用重新启动。',
            'restart.hint': '正在跑的那一轮回答会被中断；会话记录已存在硬盘上，重开即可恢复。窗口会关掉，几秒后自己回到前台。',
            'restart.yes': '立即重启',
            'restart.waiting': '正在重启…',
            'error.action': '操作失败：',
            'settings.summary.on': '侧栏显示重启按钮',
            'settings.summary.off': '侧栏不显示重启按钮',
            'settings.heading': '功能设置',
            'settings.reload.title': '显示「重载页面」按钮',
            'settings.reload.hint': '在侧栏底部加一个按钮，点它一秒左右重新加载界面，不会重启程序。',
            'settings.restart.title': '显示「重启应用」按钮',
            'settings.restart.hint': '在侧栏底部加一个按钮，点它会关闭并重新启动 DeepSeek Harness。',
            'settings.autoClean.title': '自动清理 7 天前的备份',
            'settings.autoClean.hint': '不勾选就永远不自动删备份。旧版默认目录里的备份不会被清理。',
            'settings.failed': '这个设置没保存成功，再试一次。',
            'settings.backupDir.title': '备份位置',
            'settings.backupDir.save': '保存',
            'settings.backupDir.hint': '删除会话前会把对话拷贝到这里。留空则用默认目录。当前生效：{path}',
            'settings.summary.reload.on': '重载按钮',
            'settings.summary.reload.off': '不显示重载按钮',
            'reload.label': '重载页面',
            'backups.heading': '备份恢复',
            'backups.empty': '备份目录里还没有备份。',
            'backups.loading': '正在读取备份…',
            'backups.failed': '读不到备份目录。',
            'backups.restore': '恢复',
            'backups.restoring': '恢复中…',
            'backups.restored': '已恢复，正在刷新页面…',
            'backups.restoreFailed': '恢复失败：',
            'backups.partial': '已恢复，但这几项状态没还原：',
            'backups.noManifest': '缺少清单，需手工拷回',
            'backups.remove': '删除',
            'backups.removing': '删除中…',
            'backups.removeTitle': '删除这个备份？',
            'backups.removeBody': '会话「{label}」的备份（{size}）会从硬盘删除，删掉之后就恢复不了了。',
            'backups.removeHint': '会话本身不受影响，删掉的只是备份副本。',
            'backups.removed': '备份已删除。',
            'backups.removeFailed': '删除备份失败：',
            'backups.legacy': '来自旧目录',
            'error.code.failed': '宿主报了一个错误：{detail}',
            'error.code.bad-backup-id': '备份名字不合法。',
            'error.code.bad-session-id': '会话名字不合法。',
            'error.code.manifest-missing': '这份备份缺少清单文件，没法自动恢复。',
            'error.code.invalid-session': '这份备份里没有有效的会话信息。',
            'error.code.session-exists': '这个会话已经存在，什么都没恢复。',
            'error.code.target-exists': '恢复目标已经存在，什么都没动：{detail}',
            'error.code.nothing-restored': '这份备份里的文件都不在了，没法拷回来。',
            'error.code.backup-missing': '备份目录里已经没有这份备份了。',
            'error.code.backup-not-directory': '那个路径不是文件夹。',
            'error.code.session-not-found': '这个会话在当前配置里已经找不到了。',
            'error.code.self-delete': '不能删掉正在处理这次请求的会话，请换一个。',
            'error.code.restart-unsupported': '重启功能目前只在 Windows 上实现。',
            'error.code.restart-in-progress': '已经在重启过程中了。',
            'error.code.restart-unavailable': '这个 Host 不在桌面应用里跑，没法重启。',
            'error.code.restart-helper-failed': '启动重启助手失败：{detail}',
            'error.code.body-too-large': '请求体太大了。',
            'error.code.bad-json': '请求体不是合法的 JSON。',
            'error.code.method-not-allowed': '这个操作不接受这种请求方式。',
            'error.code.unknown-action': '未知操作。',
          })
        } catch {
          // A locale registration clash must not disable the action itself.
        }
        try {
          translate = ctx.locale.bind('dsh-session-revenant')
        } catch {
          translate = (key) => key
        }

        ctx.effect(() => {
          if (document.getElementById(STYLE_ID) !== null) return () => {}
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-session-revenant: styles')

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: ITEM_ID,
          order: ITEM_ORDER,
          label: () => text('action.delete'),
        }, DeleteSessionItem))

        ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
          name: FOOTER_SLOT,
          id: RELOAD_ID,
          order: RELOAD_ORDER,
          label: () => text('reload.label'),
        }, ReloadPageAction))

        ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
          name: FOOTER_SLOT,
          id: RESTART_ID,
          order: RESTART_ORDER,
          label: () => text('restart.label'),
        }, RestartAppAction))

        ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
          name: SETTINGS_SLOT,
          key: SETTINGS_KEY,
          id: SETTINGS_ID,
          order: 10,
          label: () => text('settings.summary.on'),
        }, RevenantSettings))

        // Read the stored preference once, so a button the user already hid does
        // not flash into the sidebar on every page load.
        void loadSettings()
      },
    }
  },
})
