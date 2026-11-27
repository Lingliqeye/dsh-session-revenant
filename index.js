/**
 * dsh-session-revenant — Host half.
 *
 * Owns the real deletion. The Web UI has no session-delete entry point: the
 * workspace controller can archive and restore a session but never remove one,
 * so this plugin does the parts the Host API cannot express:
 *
 *   1. refuse to delete the session that is serving this request;
 *   2. when the caller asked for a backup, copy the session log, projection
 *      cache and workspace file to a backup directory (nothing is removed
 *      before every copy that exists succeeded);
 *   3. detach the session from its workspace and the archive/pin sets through
 *      the durable registry, so the row disappears from the Web UI at once and
 *      cannot come back on the next boot;
 *   4. remove the session log directory, its projection cache and its rows in
 *      the context overview cache.
 *
 * The request body is `{ sessionId, backup? }`. `backup` defaults to `true`; a
 * caller that passes `false` gets a real purge with no copy left behind.
 *
 * Eight actions are registered on the Web carrier as one prefix:
 *
 *   - `POST /dsh-session-revenant/delete`  — remove the session;
 *   - `POST /dsh-session-revenant/size`    — measure it first, so the dialog can
 *     show how much space is about to go away and how big a backup would be;
 *   - `GET /dsh-session-revenant/backups`  — list what the backup directory holds;
 *   - `POST /dsh-session-revenant/restore` — copy one backup back to the paths it
 *     came from and re-attach its session, refusing to overwrite anything;
 *   - `POST /dsh-session-revenant/discard` — delete one backup directory for good,
 *     after the UI confirmed the size it frees;
 *   - `POST /dsh-session-revenant/cleanup` — sweep backups older than the retention
 *     window out of the active backup directory;
 *   - `POST /dsh-session-revenant/restart` — relaunch the desktop application;
 *   - `GET|POST /dsh-session-revenant/config` — read or write this plugin's own
 *     preferences, so the sidebar buttons can be hidden on request. The
 *     preference is a small JSON file under the DSH home directory; it is not
 *     the profile's `cordis.patch.yml`, which is the user's file.
 *
 * The restart one exists because the desktop shell exposes no restart channel to
 * the Web UI: the [应用] menu entry is Windows-only chrome built in the main
 * process and gated behind a development build. The Host half runs inside the
 * desktop application, so it can hand a detached helper script the pid of the
 * process that owns it and let that script stop and relaunch the executable.
 *
 * The Client half calls all of them with a same-origin fetch.
 */
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { captureContextEntry, restoreContextEntry } from './context-index.js'

const ROUTE_PATH = '/dsh-session-revenant'
const GUARD_HEADER = 'x-dsh-session-revenant-guard'
const MAX_BODY_BYTES = 64 * 1024
const BACKUP_ENV = 'DSH_SESSION_DELETE_BACKUP'
const RESTART_ENV = 'DSH_SESSION_REAPER_RESTART'
const SETTINGS_ENV = 'DSH_SESSION_REAPER_HOME'

/** Preferences a user can change from the plugin page. */
const DEFAULT_SETTINGS = Object.freeze({ restartAction: true, reloadAction: true, backupDir: '', autoClean: false })

/** How old a backup may get before the automatic sweep removes it. */
const AUTO_CLEAN_DAYS = 7

/** How long a finished backup may live when automatic cleaning is on. */
const AUTO_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The backup directory this plugin uses when the user has not chosen one. */
const BACKUP_DIR_NAME = 'dsh-session-backups'

/** The preferences loaded by this process, or `null` before the first read. */
let cachedSettings = null

/**
 * A failure that maps onto one HTTP status instead of a 500.
 *
 * `code` is what the Client half translates: the message is an English developer
 * string, so a non-English UI shows its own wording for the same failure instead
 * of leaking the message.
 */
class HttpError extends Error {
  constructor(status, message, code = 'failed') {
    super(message)
    this.status = status
    this.code = code
  }
}

export const name = 'dsh-session-revenant'
export const inject = ['webServer']

/**
 * Register the deletion route.
 * @param ctx - plugin context carrying the web carrier and the Host services.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: (req, res) => { void handle(ctx, req, res) },
    }),
    'dsh-session-revenant: http route',
  )
  // The retention sweep runs only when the user turned it on, and it is cheap
  // enough (one directory listing) to also catch a session that has been open
  // through several days.
  ctx.effect(
    () => {
      let stopped = false
      let timer = null
      const tick = async () => {
        if (stopped) return
        try {
          const settings = await loadSettings()
          if (settings.autoClean) await pruneOldBackups()
        } catch {
          // A failed sweep must never affect the plugin.
        }
        if (!stopped) {
          timer = setTimeout(() => { void tick() }, AUTO_CLEAN_INTERVAL_MS)
          if (typeof timer.unref === 'function') timer.unref()
        }
      }
      const first = setTimeout(() => { void tick() }, 20000)
      if (typeof first.unref === 'function') first.unref()
      return () => {
        stopped = true
        if (timer !== null) clearTimeout(timer)
        clearTimeout(first)
      }
    },
    'dsh-session-revenant: backup retention',
  )
}

/**
 * One HTTP exchange. The path suffix after the prefix selects the action.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - outgoing response.
 */
async function handle(ctx, req, res) {
  try {
    assertCallerIsDsh(req)
    const action = actionOf(req.url)
    if (action === 'config') {
      await handleConfig(req, res)
      return
    }
    if (action === 'backups') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed', code: 'method-not-allowed' })
        return
      }
      sendJson(res, 200, { ok: true, ...(await listBackups()) })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed', code: 'method-not-allowed' })
      return
    }
    if (action === 'restore') {
      const body = await readJsonBody(req)
      const report = await restoreBackup(ctx, body?.backup)
      sendJson(res, 200, { ok: true, ...report })
      return
    }
    if (action === 'discard') {
      const body = await readJsonBody(req)
      const report = await removeBackup(body?.backup)
      sendJson(res, 200, { ok: true, ...report })
      return
    }
    if (action === 'restart') {
      const report = await restartDesktop()
      sendJson(res, 200, { ok: true, ...report })
      return
    }
    if (action === 'cleanup') {
      const body = await readJsonBody(req)
      const report = await pruneOldBackups(body?.days)
      sendJson(res, 200, { ok: true, ...report })
      return
    }
    if (action !== 'delete' && action !== 'size') {
      sendJson(res, 404, { ok: false, error: 'unknown action', code: 'unknown-action' })
      return
    }
    const body = await readJsonBody(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '' || !/^session-[A-Za-z0-9-]+$/.test(sessionId)) {
      sendJson(res, 400, { ok: false, error: 'a valid sessionId is required', code: 'bad-session-id' })
      return
    }
    if (action === 'size') {
      const report = await describeSize(ctx, sessionId)
      sendJson(res, 200, { ok: true, ...report })
      return
    }
    const report = await deleteSession(ctx, sessionId, { backup: body?.backup !== false })
    sendJson(res, 200, { ok: true, ...report })
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { ok: false, error: error.message, code: error.code })
      return
    }
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Reject callers that are not the DeepSeek Harness page.
 *
 * A page on another origin cannot send this header: a custom request header
 * makes the browser send a CORS preflight first, this route does not answer
 * preflights, and the browser then withholds the real request. The page's own
 * fetch is same-origin, so it is never preflighted and always carries it.
 * @param req - incoming request.
 */
function assertCallerIsDsh(req) {
  const value = req.headers?.[GUARD_HEADER]
  if (value === '1') return
  throw new HttpError(403, 'This request did not come from the DeepSeek Harness page.', 'untrusted-caller')
}

/**
 * The action suffix of a request URL under the registered prefix.
 * @param url - raw request URL.
 * @returns e.g. `delete`, `size`, or an empty string when the URL is outside.
 */
function actionOf(url) {
  const pathname = String(url ?? '').split('?')[0]
  if (!pathname.startsWith(ROUTE_PATH)) return ''
  const rest = pathname.slice(ROUTE_PATH.length)
  if (rest !== '' && !rest.startsWith('/')) return ''
  return rest.replace(/^\/+|\/+$/g, '')
}

/**
 * The title a session snapshot carries, when the persistence layer exposes one.
 * @param snapshot - result of `sessionPersistence.stat()`.
 * @returns the trimmed title, or `null`.
 */
function sessionTitleOf(snapshot) {
  const candidates = [
    snapshot?.title,
    snapshot?.meta?.title,
    snapshot?.session?.title,
    snapshot?.info?.title,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Every backup this installation can restore, newest first.
 *
 * A backup written by this plugin carries `meta.json`; a directory without one
 * (an older copy, or a hand-made folder) is listed but marked unrestorable, so
 * the page never offers a restore that would guess where the files belong.
 * @returns the backup root and one row per backup directory.
 */
async function listBackups() {
  const home = dshHome()
  const roots = await backupRoots(home)
  const backupRootPath = roots[0]?.path ?? path.join(home, BACKUP_DIR_NAME)
  const backups = []
  for (const root of roots) {
    let entries
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // A backup id is unique per installation, and the primary root wins.
      if (backups.some((row) => row.id === entry.name)) continue
      const directory = path.join(root.path, entry.name)
      let meta = null
      try {
        meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'))
      } catch {
        meta = null
      }
      const measured = await measurePath(directory)
      let createdAt = typeof meta?.createdAt === 'string' ? meta.createdAt : null
      if (createdAt === null) {
        try {
          createdAt = (await fs.stat(directory)).mtime.toISOString()
        } catch {
          createdAt = null
        }
      }
      backups.push({
        id: entry.name,
        sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : null,
        title: typeof meta?.title === 'string' && meta.title !== '' ? meta.title : null,
        createdAt,
        workspacePath: typeof meta?.workspacePath === 'string' ? meta.workspacePath : null,
        restorable: Array.isArray(meta?.parts) && meta.parts.length > 0,
        legacy: root.legacy,
        directory,
        bytes: measured.bytes,
        files: measured.files,
      })
    }
  }
  backups.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
  return { root: backupRootPath, roots: roots.map((row) => row.path), backups }
}

/**
 * Remove backups older than the retention window from the active root.
 *
 * Only the directory the plugin writes to is swept: backups found in the older
 * default location belong to a version the user ran before, so they are left
 * alone rather than expiring without warning.
 *
 * Age comes from the manifest's `createdAt`, falling back to the directory
 * mtime for a folder without one.
 *
 * @param options - `{ days }` overrides the retention window.
 * @returns the removed rows and the bytes freed.
 */
async function pruneOldBackups(options = {}) {
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : AUTO_CLEAN_DAYS
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const home = dshHome()
  const root = backupRoot(home, await loadSettings())
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return { root, days, removed: [], freed: 0 }
  }
  const removed = []
  let freed = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(root, entry.name)
    let when = null
    try {
      const meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'))
      if (typeof meta?.createdAt === 'string') when = Date.parse(meta.createdAt)
    } catch {
      when = null
    }
    if (when === null || Number.isNaN(when)) {
      try {
        when = (await fs.stat(directory)).mtimeMs
      } catch {
        continue
      }
    }
    if (when > cutoff) continue
    const measured = await measurePath(directory)
    try {
      await fs.rm(directory, { recursive: true, force: true })
    } catch {
      continue
    }
    removed.push({ id: entry.name, bytes: measured.bytes })
    freed += measured.bytes
  }
  return { root, days, removed, freed }
}

/**
 * Put one backup back where it came from and attach its session again.
 *
 * Nothing is overwritten: a restore that finds the session directory or a live
 * session already present answers `409`, so a half-restore can never clobber a
 * session the user is working in.
 * @param ctx - plugin context.
 * @param backupId - the backup directory name, as listed by `listBackups`.
 * @returns what was copied and which workspace claimed the session.
 */
async function restoreBackup(ctx, backupId) {
  const id = typeof backupId === 'string' ? backupId.trim() : ''
  if (id === '' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new HttpError(400, 'a valid backup id is required', 'bad-backup-id')
  }
  const located = await locateBackup(id)
  const directory = located.directory
  let meta
  try {
    meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'))
  } catch {
    throw new HttpError(409, 'This backup carries no manifest, so it cannot be restored automatically.', 'manifest-missing')
  }
  const sessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : ''
  if (!/^session-[A-Za-z0-9-]+$/.test(sessionId)) {
    throw new HttpError(409, 'This backup does not name a valid session.', 'invalid-session')
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.stat === 'function') {
    if (await persistence.stat(sessionId)) {
      throw new HttpError(409, 'That session already exists; nothing was restored.', 'session-exists')
    }
  }

  const restored = []
  const parts = Array.isArray(meta.parts) ? meta.parts : []
  for (const part of parts) {
    const name = typeof part?.name === 'string' ? part.name : ''
    const source = typeof part?.source === 'string' ? part.source : ''
    if (name === '' || source === '' || !path.isAbsolute(source)) continue
    // A projection cache is derived: it is rebuilt from the log, so replacing a
    // stale copy loses nothing. The log itself is never overwritten.
    if (isDerivedPath(source)) continue
    if (await pathExists(source)) {
      throw new HttpError(409, `A restore target already exists: ${source}. Nothing was restored.`, 'target-exists')
    }
  }
  for (const part of parts) {
    const name = typeof part?.name === 'string' ? part.name : ''
    const source = typeof part?.source === 'string' ? part.source : ''
    if (name === '' || source === '' || !path.isAbsolute(source)) continue
    const from = path.join(directory, name)
    try {
      await fs.stat(from)
    } catch {
      continue
    }
    await fs.mkdir(path.dirname(source), { recursive: true })
    await fs.cp(from, source, { recursive: true })
    restored.push(source)
  }
  if (restored.length === 0) {
    throw new HttpError(409, 'Nothing in this backup could be copied back; its files are missing.', 'nothing-restored')
  }

  const flags = {
    archived: meta?.archived === true,
    pinned: meta?.pinned === true,
  }
  const problems = []
  let attachedTo = null
  const registry = ctx.get('workspaceRegistry')
  const workspacePath = typeof meta?.workspacePath === 'string' ? meta.workspacePath : ''
  if (registry && workspacePath !== '') {
    try {
      let workspace
      try {
        workspace = await registry.resolveByPath(workspacePath)
      } catch {
        workspace = undefined
      }
      if (!workspace && typeof registry.create === 'function') {
        workspace = await registry.create(workspacePath)
      }
      if (workspace && typeof workspace.attachSession === 'function') {
        await workspace.attachSession(sessionId)
        attachedTo = workspacePath
      }
    } catch (error) {
      // The files are back; a session the sidebar does not list yet is still
      // recoverable by opening the workspace again.
      problems.push(`attach: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // The archive and pin sets are registry-global, so they are restored on the
  // registry rather than on the workspace. A session the registry refuses to
  // archive (running work, for instance) still comes back, just not archived.
  if (registry) {
    if (flags.pinned && typeof registry.pinSession === 'function') {
      try {
        await registry.pinSession(sessionId)
      } catch (error) {
        flags.pinned = false
        problems.push(`pin: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (flags.archived && typeof registry.archiveSession === 'function') {
      try {
        await registry.archiveSession(sessionId)
      } catch (error) {
        flags.archived = false
        problems.push(`archive: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  // The sidebar reads a session title from the context overview shards, not from
  // the log header, so a session whose shard row was pruned on delete comes back
  // as "unnamed" until someone opens it. Put the row back while the sidebar is
  // still watching. A missing shard is not a problem: the index rebuilds.
  let contextRow = null
  try {
    const record = JSON.parse(await fs.readFile(path.join(directory, 'context.json'), 'utf8'))
    contextRow = await restoreContextEntry(dshHome(), sessionId, record)
  } catch {
    // No captured row: the title returns on the first open instead.
  }
  return { backupId: id, sessionId, restored, attachedTo, flags, problems, contextRow }
}

/**
 * Delete one backup directory for good. Nothing of the session is touched: only
 * the copy written before an earlier deletion is removed, which is why this one
 * asks for confirmation in the UI and reports the size it is about to free.
 * @param backupId - the backup directory name, as listed by `listBackups`.
 * @returns the removed id and the bytes that were freed.
 */
async function removeBackup(backupId) {
  const id = typeof backupId === 'string' ? backupId.trim() : ''
  if (id === '' || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new HttpError(400, 'a valid backup id is required', 'bad-backup-id')
  }
  const located = await locateBackup(id)
  const directory = located.directory
  let stats
  try {
    stats = await fs.lstat(directory)
  } catch {
    throw new HttpError(404, 'That backup is not in the backup directory any more.', 'backup-missing')
  }
  if (!stats.isDirectory()) {
    throw new HttpError(409, 'That backup is not a directory.', 'backup-not-directory')
  }
  const measured = await measurePath(directory)
  await fs.rm(directory, { recursive: true, force: true })
  return { backupId: id, bytes: measured.bytes, files: measured.files }
}

/**
 * Read or write the plugin's own preferences.
 *
 * The sidebar restart button is a plugin-owned control, so whether it appears is
 * a plugin preference, not DSH configuration: a small `settings.json` under the
 * DSH home keeps it out of the user's profile patch.
 * @param req - incoming request (`GET` to read, `POST` to change).
 * @param res - outgoing response carrying `{ ok, config }`.
 */
async function handleConfig(req, res) {
  if (req.method === 'GET') {
    const config = await loadSettings()
    sendJson(res, 200, {
      ok: true,
      config,
      backupRoot: backupRoot(dshHome(), config),
      defaultBackupRoot: path.join(dshHome(), BACKUP_DIR_NAME),
    })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed', code: 'method-not-allowed' })
    return
  }
  const body = await readJsonBody(req)
  const patch = {}
  if (typeof body?.restartAction === 'boolean') patch.restartAction = body.restartAction
  if (typeof body?.reloadAction === 'boolean') patch.reloadAction = body.reloadAction
  if (typeof body?.backupDir === 'string') patch.backupDir = body.backupDir
  if (typeof body?.autoClean === 'boolean') patch.autoClean = body.autoClean
  const config = await saveSettings({ ...(await loadSettings()), ...patch })
  sendJson(res, 200, {
    ok: true,
    config,
    backupRoot: backupRoot(dshHome(), config),
    autoCleanDays: AUTO_CLEAN_DAYS,
  })
}

/** The directory holding this plugin's preferences. */
function settingsDir() {
  const override = process.env[SETTINGS_ENV]
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, '.session_reaper')
}

/** The preferences file. */
function settingsFile() {
  return path.join(settingsDir(), 'settings.json')
}

/**
 * The preferences as they are on disk, with defaults for anything missing or
 * unreadable. A corrupt file falls back to the defaults instead of failing the
 * page: the wrong preference is recoverable, a broken plugin page is not.
 * @returns a complete preferences object.
 */
async function loadSettings() {
  if (cachedSettings !== null) return cachedSettings
  let parsed = null
  try {
    parsed = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
  } catch {
    parsed = null
  }
  cachedSettings = normalizeSettings(parsed)
  return cachedSettings
}

/**
 * Write the preferences and move the in-process cache to the same value, so a
 * read that follows a write never sees the old file.
 * @param value - the complete preferences object to persist.
 * @returns the stored preferences.
 */
async function saveSettings(value) {
  const config = normalizeSettings(value)
  const file = settingsFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  cachedSettings = config
  return config
}

/**
 * Coerce arbitrary input into a complete preferences object.
 * @param value - raw parsed JSON, or `null`.
 * @returns every known preference with a valid value.
 */
function normalizeSettings(value) {
  return {
    restartAction: typeof value?.restartAction === 'boolean'
      ? value.restartAction
      : DEFAULT_SETTINGS.restartAction,
    reloadAction: typeof value?.reloadAction === 'boolean'
      ? value.reloadAction
      : DEFAULT_SETTINGS.reloadAction,
    backupDir: normalizeBackupDir(value?.backupDir),
    autoClean: typeof value?.autoClean === 'boolean'
      ? value.autoClean
      : DEFAULT_SETTINGS.autoClean,
  }
}

/**
 * A user-chosen backup directory, or an empty string to use the default.
 *
 * Only an absolute path is kept: a relative one would resolve against whatever
 * working directory the Host happens to have, which is not something a user can
 * predict or repair.
 * @param value - raw preference value.
 * @returns the normalized absolute path, or an empty string.
 */
function normalizeBackupDir(value) {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.backupDir
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (!path.isAbsolute(trimmed)) return ''
  return path.normalize(trimmed)
}

/**
 * Relaunch the desktop application that owns this Host process.
 *
 * The Host has no IPC channel into the Electron main process, so the way out is
 * a detached helper: this process writes a small Node script, starts it with the
 * application executable in `ELECTRON_RUN_AS_NODE` mode, and the helper waits for
 * the HTTP response to drain before it stops the application and launches it
 * again.
 *
 * It is a Node helper rather than a PowerShell one on purpose: on machines where
 * a security product blocks script hosts, `powershell.exe -File` starts and exits
 * with code 0 without running a single line, which made the first version of
 * this feature do nothing at all (five stale `.ps1` helpers, application still
 * running, every later click answering 409). A Node child process runs there
 * without complaint, and Node has everything the helper needs.
 *
 * The helper is deliberately fail-safe: it parks a watchdog first, then sleeps
 * before touching anything, so a helper that dies early leaves the application
 * running.
 * @returns the processes it will stop and restart, and the helper it wrote.
 */
async function restartDesktop() {
  if (process.platform !== 'win32') {
    throw new HttpError(501, 'Restarting the desktop application is only implemented on Windows.', 'restart-unsupported')
  }
  if (restartingSince !== 0 && Date.now() - restartingSince < RESTART_GUARD_MS) {
    throw new HttpError(409, 'A restart is already in progress.', 'restart-in-progress')
  }
  const exe = process.execPath
  const appPid = process.ppid
  const hostPid = process.pid
  if (!Number.isInteger(appPid) || appPid <= 0 || !/harness/i.test(path.basename(exe))) {
    throw new HttpError(501, 'This Host does not run inside the DeepSeek Harness desktop application.', 'restart-unavailable')
  }
  const dir = process.env[RESTART_ENV] ?? tmpdir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const helperPath = path.join(dir, `dsh-session-revenant-restart-${stamp}.mjs`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(helperPath, buildRestartHelper(exe, appPid, hostPid), 'utf8')
  const helper = spawn(process.execPath, [helperPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  await waitForSpawn(helper)
  helper.unref()
  restartingSince = Date.now()
  return {
    appPid,
    executable: exe,
    helper: helperPath,
    watchdogMs: RESTART_WATCHDOG_MS,
    delayMs: RESTART_DELAY_MS,
  }
}

/**
 * Wait until a child either started or failed to start, so a helper that cannot
 * be created answers the caller instead of pretending the restart is on its way.
 * @param child - the spawned helper process.
 * @throws HttpError when the process could not be created.
 */
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const settle = setTimeout(() => resolve(), 400)
    child.once('spawn', () => {
      clearTimeout(settle)
      resolve()
    })
    child.once('error', (error) => {
      clearTimeout(settle)
      reject(new HttpError(500, `Could not start the restart helper: ${error.message}`, 'restart-helper-failed'))
    })
  })
}

/** When this process last asked a helper to restart the application. */
let restartingSince = 0

/** How long a restart request blocks new ones. */
const RESTART_GUARD_MS = 30000

/** How long the helper waits so the HTTP response can finish. */
const RESTART_DELAY_MS = 1500

/** How long the parked watchdog waits before relaunching the executable. */
const RESTART_WATCHDOG_MS = 9000

/**
 * The helper script. ASCII only, so no encoding guess is involved.
 *
 * Two processes, one file:
 *   - the helper parks a watchdog, stops the application, then launches it;
 *   - the watchdog relaunches only if nothing by that executable name is left
 *     after `RESTART_WATCHDOG_MS`, which covers a helper that dies before the
 *     application is back.
 *
 * Why the main process is stopped by pid and the Host is left alone: the helper
 * is a descendant of the Host, so `taskkill /T` would take the helper with it
 * and the application would never come back. Stopping the Host explicitly is
 * unnecessary — it goes down with its parent — and it made the relaunch
 * noticeably slower, because the new Host then rebuilt everything before the
 * window could open.
 * @param exe - absolute path of the application executable.
 * @param appPid - process id of the application main process.
 * @param hostPid - process id of the Host process running this plugin.
 * @returns the script text.
 */
function buildRestartHelper(exe, appPid, hostPid) {
  const target = JSON.stringify(exe)
  const directory = JSON.stringify(path.dirname(exe))
  const image = JSON.stringify(path.basename(exe))
  return `import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'

const EXE = ${target}
const DIR = ${directory}
const IMAGE = ${image}
const APP_PID = ${appPid}
const HOST_PID = ${hostPid}
const SELF = process.argv[1]
const LOG = SELF.replace(/\.mjs$/, '.log')
const WATCHDOG_MS = ${RESTART_WATCHDOG_MS}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function note(message) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + message + '\\n') } catch {}
}

function launch() {
  note('launch ' + EXE)
  try {
    // windowsHide must stay false: it reaches the new process as STARTUPINFO
    // with SW_HIDE, and the first window the application shows then comes up
    // hidden, which is exactly the "window is only in the tray" symptom.
    spawn(EXE, [], { detached: true, stdio: 'ignore', windowsHide: false, cwd: DIR, env }).unref()
  } catch (error) {
    note('launch failed: ' + error.message)
  }
}

function tasklist(args) {
  try {
    const result = spawnSync('tasklist.exe', args, { encoding: 'latin1', windowsHide: true })
    return typeof result.stdout === 'string' ? result.stdout.toLowerCase() : ''
  } catch {
    return ''
  }
}

/** Whether any process of the application is still alive, renderers included. */
function appIsRunning() {
  return tasklist(['/FI', 'IMAGENAME eq ' + IMAGE, '/NH', '/FO', 'CSV']).includes(IMAGE.toLowerCase())
}

function pidAlive(pid) {
  return tasklist(['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV']).includes('"' + pid + '"')
}

function killPid(pid) {
  note('kill ' + pid)
  try {
    spawnSync('taskkill.exe', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  } catch (error) {
    note('kill failed: ' + error.message)
  }
}

if (process.argv.includes('--watch')) {
  note('watchdog awake')
  await sleep(WATCHDOG_MS)
  if (appIsRunning()) {
    note('watchdog: application is up, nothing to do')
  } else {
    note('watchdog: application is gone, relaunching')
    launch()
  }
  try { fs.rmSync(SELF, { force: true }) } catch {}
  try { fs.rmSync(LOG, { force: true }) } catch {}
  process.exit(0)
}

note('helper start, app ' + APP_PID + ', host ' + HOST_PID)
// Park the watchdog first: it must survive whatever happens to this process.
try {
  spawn(process.execPath, [SELF, '--watch'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref()
} catch (error) {
  note('watchdog spawn failed: ' + error.message)
}

await sleep(250)
killPid(APP_PID)
// A fixed pause, not a poll, and the Host is left alone: the Host goes down
// with its parent on its own, and stopping it explicitly only made the relaunch
// slower — the fresh Host then had to rebuild everything before the window
// could appear.
await sleep(2500)
launch()
// Then ask the running application to show its window, a few times. A launch
// that loses the single instance race is forwarded to the owner as a
// "second-instance" event, which restores a minimized window, shows it and
// focuses it — the same path as clicking the tray icon. The owner ignores that
// request while it is still starting up, so the request has to be repeated
// instead of sent once: each repeat costs a process that exits immediately.
for (let attempt = 0; attempt < 5; attempt += 1) {
  await sleep(attempt === 0 ? 3500 : 3000)
  launch()
}
await sleep(1000)
try { fs.rmSync(SELF, { force: true }) } catch {}
`
}

/**
 * Measure a session without touching it: how much its files occupy today, and
 * how much a backup copy would add (the same footprint plus the workspace
 * registry the backup also copies).
 * @param ctx - plugin context.
 * @param sessionId - session to measure.
 * @returns byte and file counts for the session and for a backup.
 */
async function describeSize(ctx, sessionId) {
  const home = dshHome()
  const persistence = ctx.get('sessionPersistence')
  let snapshot = null
  if (persistence && typeof persistence.stat === 'function') {
    try {
      snapshot = await persistence.stat(sessionId)
    } catch {
      // Same fallback as the deletion itself: measure what the layout carries.
      snapshot = null
    }
  }

  const targets = await collectTargets(home, sessionId, snapshot)
  if (targets.length === 0) {
    throw new HttpError(404, 'Session not found.', 'session-not-found')
  }
  let sessionBytes = 0
  let files = 0
  let copiedBytes = 0
  for (const target of targets) {
    const measured = await measurePath(target)
    sessionBytes += measured.bytes
    files += measured.files
    // The backup skips derived caches, so it must not be quoted at their size.
    if (!isDerivedPath(target)) copiedBytes += measured.bytes
  }

  return {
    sessionId,
    sessionBytes,
    files,
    backupBytes: copiedBytes,
    parts: targets.length,
  }
}

/**
 * Whether a path exists, without throwing on a permission error.
 * @param target - file or directory.
 * @returns `true` when `lstat` succeeds.
 */
async function pathExists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a path is a rebuildable derived file rather than session data.
 *
 * The projection cache under `storages/session_projcache` is regenerated from
 * the session log, so a restore may replace it. Everything else — the log
 * directory above all — is only ever written into empty space.
 *
 * @param target - absolute path from a backup manifest.
 * @returns `true` for derived caches.
 */
function isDerivedPath(target) {
  const marker = `${path.sep}storages${path.sep}session_projcache${path.sep}`
  return target.includes(marker)
}

/**
 * Total bytes and file count under one path (directories walked recursively,
 * symlinks counted as one entry and never followed).
 * @param target - file or directory.
 * @returns `{ bytes, files }`.
 */
async function measurePath(target) {
  let info
  try {
    info = await fs.lstat(target)
  } catch {
    return { bytes: 0, files: 0 }
  }
  if (!info.isDirectory()) return { bytes: info.size, files: 1 }
  let bytes = 0
  let files = 0
  let entries
  try {
    entries = await fs.readdir(target, { withFileTypes: true })
  } catch {
    return { bytes: 0, files: 0 }
  }
  for (const entry of entries) {
    const measured = await measurePath(path.join(target, entry.name))
    bytes += measured.bytes
    files += measured.files
  }
  return { bytes, files }
}


/**
 * The whole deletion, in the order documented on the module.
 * @param ctx - plugin context.
 * @param sessionId - session to remove.
 * @param options - `backup: false` skips the copy and purges for real.
 * @returns what was backed up (or null) and what was removed.
 */
async function deleteSession(ctx, sessionId, options = {}) {
  if (process.env.DSH_SESSION_ID === sessionId) {
    throw new HttpError(409, 'Refusing to delete the session that is serving this request.', 'self-delete')
  }
  const home = dshHome()
  const persistence = ctx.get('sessionPersistence')
  let snapshot = null
  if (persistence && typeof persistence.stat === 'function') {
    try {
      snapshot = await persistence.stat(sessionId)
    } catch {
      // A log this build cannot read back — a truncated write after a hard
      // shutdown, for example — still leaves a directory on disk and a row in
      // the sidebar. Telling the user "not found" would leave that leftover
      // undeletable from the UI, so fall back to what the layout shows.
      snapshot = null
    }
  }

  const targets = await collectTargets(home, sessionId, snapshot)
  const registry = ctx.get('workspaceRegistry')
  const knownToRegistry = Boolean(registry && typeof registry.list === 'function'
    && registry.list().some((workspace) => (workspace?.sessionIds ?? []).includes(sessionId)))
  if (targets.length === 0 && !knownToRegistry) {
    throw new HttpError(404, 'Session not found.', 'session-not-found')
  }

  const workspacePath = workspacePathOf(ctx.get('workspaceRegistry'), sessionId)
  // Read the archive and pin sets before the detach drops the session from both:
  // a restored conversation should come back where the user last put it.
  const flags = sessionFlagsOf(registry, sessionId)
  // Let the in-process stores release the session first, so a pending flush
  // lands while the files still exist and nothing writes them back afterwards.
  const live = await forgetLiveSession(ctx, sessionId)
  const backupDir = options.backup === false
    ? null
    : await backupTargets(home, sessionId, targets, workspacePath, sessionTitleOf(snapshot), flags)

  await detachFromRegistry(ctx.get('workspaceRegistry'), sessionId)

  const removed = []
  for (const target of targets) {
    await fs.rm(target, { recursive: true, force: true })
    removed.push(target)
  }
  const prunedShards = await pruneContextIndex(home, sessionId)
  scheduleDerivedCleanup(home, sessionId)
  return { sessionId, backupDir, removed, prunedShards, live }
}

/**
 * Delete the projection cache once more, shortly after the delete returns.
 *
 * An idle Agent that was still attached when the row went away can flush its
 * projection a moment later and recreate the file. One delayed pass catches
 * that without holding the request open.
 *
 * @param home - DSH home directory.
 * @param sessionId - session whose cache should stay gone.
 */
function scheduleDerivedCleanup(home, sessionId) {
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  const timer = setTimeout(() => {
    fs.rm(file, { force: true }).catch(() => {})
  }, 900)
  if (typeof timer.unref === 'function') timer.unref()
}

/**
 * Drop one session from the in-memory Agent and Session stores.
 *
 * Both stores hand out a detach capability from `enter()`; the owner keeps it.
 * Removing the row directly with `detachEntered` is the same teardown that
 * capability performs, and it emits the paired disposal event so subscribers
 * forget the session too. Without this the sidebar keeps listing the session
 * until the Host restarts, because the list merges the live store in.
 *
 * @param ctx - plugin context.
 * @param sessionId - session to release.
 * @returns which store released it, per store, plus whatever refused.
 */
async function forgetLiveSession(ctx, sessionId) {
  const report = { agent: false, session: false, errors: [] }
  try {
    const agents = ctx.get('agents')
    const entry = agents?.store?.get?.(sessionId)
    if (entry != null && typeof agents.detachEntered === 'function') {
      agents.detachEntered(entry)
      report.agent = true
    }
  } catch (error) {
    report.errors.push(`agent: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const sessions = ctx.get('sessions')
    const entry = sessions?.store?.get?.(sessionId)
    if (entry != null && typeof sessions.detachEntered === 'function') {
      sessions.detachEntered(entry)
      report.session = true
    }
  } catch (error) {
    report.errors.push(`session: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (report.agent || report.session) {
    // Give an interrupted writer a moment to settle before the files go away.
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return report
}

/**
 * Every filesystem path that belongs to the session.
 * @param home - DSH home directory.
 * @param sessionId - session to locate.
 * @param snapshot - persistence snapshot when the service answered.
 * @returns existing paths only.
 */
async function collectTargets(home, sessionId, snapshot) {
  const found = new Set()
  const location = snapshot?.location?.path
  if (typeof location === 'string' && location !== '') {
    const directory = path.dirname(location)
    if (path.basename(directory) === sessionId) found.add(directory)
    else found.add(location)
  }
  // Fall back to the documented layout when persistence gave no location.
  const sessionsRoot = path.join(home, 'sessions')
  let projectDirs = []
  try {
    projectDirs = await fs.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    projectDirs = []
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(sessionsRoot, entry.name, sessionId)
    try {
      await fs.stat(candidate)
      found.add(candidate)
    } catch {
      // Not this project bucket.
    }
  }
  found.add(path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`))
  const existing = []
  for (const candidate of found) {
    try {
      await fs.stat(candidate)
      existing.push(candidate)
    } catch {
      // Already gone; nothing to remove or copy.
    }
  }
  return existing
}

/**
 * Copy the session footprint before anything is removed. A copy failure aborts
 * the deletion untouched.
 *
 * The manifest, not a copy of the workspace registry, is what makes a restore
 * exact: it records where each part came from and which workspace the session
 * belonged to. The registry file itself is large, changes constantly and is
 * never read back on restore, so it is not copied.
 * @param home - DSH home directory.
 * @param sessionId - session being removed.
 * @param targets - paths collected for the session.
 * @param workspacePath - the workspace the session was attached to.
 * @param title - the session title, when known.
 * @returns the backup directory.
 */
async function backupTargets(home, sessionId, targets, workspacePath, title, flags = {}) {
  const root = backupRoot(home, await loadSettings())
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const directory = path.join(root, `${sessionId}-${stamp}`)
  await fs.mkdir(directory, { recursive: true })
  const parts = []
  for (const target of targets) {
    // The projection cache is optional derived data and can be most of the
    // bytes: a restore rebuilds it on the first open, so it is not copied.
    if (isDerivedPath(target)) continue
    const name = path.basename(target)
    const destination = path.join(directory, name)
    await fs.cp(target, destination, { recursive: true })
    parts.push({ name, source: target })
  }
  // The manifest is what makes a restore exact: without the original paths the
  // copy could only guess which project bucket the session belonged to.
  const meta = {
    version: 1,
    sessionId,
    title: typeof title === 'string' && title !== '' ? title : null,
    createdAt: new Date().toISOString(),
    workspacePath: workspacePath ?? null,
    archived: flags.archived === true,
    pinned: flags.pinned === true,
    parts,
  }
  await fs.writeFile(path.join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  // The session title does not live in the log header: it is a row in the
  // context overview shards. Copy that row too, or a restored session shows up
  // as "unnamed" in the sidebar until someone opens it once.
  try {
    const captured = await captureContextEntry(home, sessionId)
    if (captured !== null) {
      await fs.writeFile(path.join(directory, 'context.json'), `${JSON.stringify(captured, null, 2)}\n`, 'utf8')
    }
  } catch {
    // The backup still restores; only the title waits for the first open.
  }
  return directory
}

/**
 * The backup root for this installation.
 *
 * Precedence is: the directory the user chose on the plugin page, then the
 * `DSH_SESSION_DELETE_BACKUP` environment variable (kept so an older setup keeps
 * working), then `<DSH_HOME>/dsh-session-backups`.
 *
 * The default used to be `<DSH_HOME>/../备份/session-delete`. That name is
 * Chinese, it sits outside the DSH data directory, and nobody could find it, so
 * new backups go to a plain ASCII folder inside the data directory. Backups
 * written by an older version are still listed and restorable.
 * @param home - DSH home directory.
 * @param settings - the plugin preferences, when already loaded.
 * @returns the absolute backup root.
 */
function backupRoot(home, settings) {
  const chosen = typeof settings?.backupDir === 'string' ? settings.backupDir : ''
  if (chosen !== '') return path.resolve(chosen)
  const override = process.env[BACKUP_ENV]
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  return path.join(home, BACKUP_DIR_NAME)
}

/**
 * Every directory this installation reads backups from, primary first.
 *
 * The legacy root is included so a backup written before the default changed is
 * still listed, restorable and removable instead of disappearing from the page.
 * @param home - DSH home directory.
 * @returns roots tagged with whether they are the legacy location.
 */
async function backupRoots(home) {
  const primary = path.resolve(backupRoot(home, await loadSettings()))
  const roots = [{ path: primary, legacy: false }]
  const legacy = path.resolve(path.join(home, '..', '备份', 'session-delete'))
  if (legacy !== primary) roots.push({ path: legacy, legacy: true })
  return roots
}

/**
 * Locate one backup directory across every root this installation knows.
 * @param id - backup directory name, already validated by the caller.
 * @returns the directory and the root it was found under.
 * @throws HttpError 404 when no root carries it.
 */
async function locateBackup(id) {
  const roots = await backupRoots(dshHome())
  for (const root of roots) {
    const directory = path.join(root.path, id)
    if (path.dirname(directory) !== root.path) continue
    try {
      const stats = await fs.lstat(directory)
      if (stats.isDirectory()) return { directory, root: root.path, legacy: root.legacy }
    } catch {
      continue
    }
  }
  throw new HttpError(404, 'That backup is not in the backup directory any more.', 'backup-missing')
}

/**
 * The directory of the workspace that owns a session, read before the row is
 * detached: a restore needs it to attach the session again.
 * @param registry - workspace registry service, when present.
 * @param sessionId - session being removed.
 * @returns the owning workspace path, or `null` when no workspace claims it.
 */
function workspacePathOf(registry, sessionId) {
  if (!registry || typeof registry.list !== 'function') return null
  for (const workspace of registry.list()) {
    if ((workspace?.sessionIds ?? []).includes(sessionId)) return workspace.path ?? null
  }
  return null
}

/**
 * Whether the session sits in the registry-global archive and pin sets. Both are
 * plain id arrays on the registry, so this is a read that cannot fail on a
 * session the registry no longer knows.
 * @param registry - workspace registry service, when present.
 * @param sessionId - session being removed.
 * @returns `{ archived, pinned }`.
 */
function sessionFlagsOf(registry, sessionId) {
  const has = (ids) => Array.isArray(ids) && ids.includes(sessionId)
  return {
    archived: Boolean(registry) && has(registry.archivedSessionIds),
    pinned: Boolean(registry) && has(registry.pinnedSessionIds),
  }
}

/**
 * Drop the session from its workspace, the archive set and the pin set. Each
 * step is durable, so the row stays gone after a restart.
 * @param registry - workspace registry service, when present.
 * @param sessionId - session being removed.
 */
async function detachFromRegistry(registry, sessionId) {
  if (!registry || typeof registry.list !== 'function') return
  for (const workspace of registry.list()) {
    const ids = workspace?.sessionIds ?? []
    if (!ids.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch {
      // Keep going: the file removal is still the authoritative cleanup.
    }
    break
  }
  try {
    await registry.unarchiveSession(sessionId)
  } catch {
    // Not archived, or the registry already forgot it.
  }
  try {
    await registry.unpinSession(sessionId)
  } catch {
    // Not pinned.
  }
}


/**
 * Drop the session from the context overview shards (the search index cache).
 * @param home - DSH home directory.
 * @param sessionId - session being removed.
 * @returns names of the shards rewritten.
 */
async function pruneContextIndex(home, sessionId) {
  const directory = path.join(home, 'storages', 'dsh-context', 'overview-cache.v3')
  let names = []
  try {
    names = await fs.readdir(directory)
  } catch {
    return []
  }
  const pruned = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(directory, name)
    let document
    try {
      document = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      continue
    }
    const sessions = document?.sessions
    let changed = false
    if (Array.isArray(sessions)) {
      const kept = sessions.filter(entry => idOfEntry(entry) !== sessionId)
      if (kept.length !== sessions.length) {
        document.sessions = kept
        changed = true
      }
    } else if (sessions && typeof sessions === 'object') {
      if (Object.prototype.hasOwnProperty.call(sessions, sessionId)) {
        delete sessions[sessionId]
        changed = true
      }
    }
    if (!changed) continue
    const temporary = `${file}.tmp`
    await fs.writeFile(temporary, JSON.stringify(document), 'utf8')
    await fs.rename(temporary, file)
    pruned.push(name)
  }
  return pruned
}

/**
 * The session id behind one overview-cache entry.
 * @param entry - one shard row.
 * @returns the id, when the row carries one.
 */
function idOfEntry(entry) {
  return entry?.materialization?.facts?.id ?? entry?.id ?? entry?.sessionId
}

/** DSH home directory, from the environment the booted Harness carries. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return path.join(homedir(), '.dsh')
}

/**
 * Read a small JSON request body.
 * @param req - incoming request.
 * @returns the parsed body.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large', 'body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text === '' ? {} : JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'invalid JSON body', 'bad-json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Write one JSON response.
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}
