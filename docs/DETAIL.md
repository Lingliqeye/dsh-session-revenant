# Session delete, backup restore, page reload and app restart

DeepSeek Harness can archive a session from the session menu, but the Web UI and
the workspace API have no way to remove one. This bundle adds that missing
action — plus a restore and delete button for the backups it writes, a page
reload control, and, because the desktop shell keeps its restart entry in a
native menu the Web UI cannot reach, a restart control of its own.

## What it does

`⋯` on a session row → **Delete session**

1. Opens a confirmation dialog: the question “Delete this conversation?”, a
   live size readout (**This session**: bytes + file count, and **Backup copy**:
   the size the backup would take; the backup row follows the checkbox), a
   **Yes, delete** button, a **No** button, and a checkbox
   **Create a backup of this conversation** (checked by default).
2. Measures the session through `POST /dsh-session-revenant/size` as soon as the
   dialog opens, without touching it.
3. When the backup box is checked: copies the session's durable footprint to a
   backup directory. A copy failure aborts the whole request before anything is
   removed.
4. Detaches the session from its workspace and removes it from the archive and
   pin sets, so the row disappears from the sidebar immediately and stays gone
   after a restart.
5. Removes the session log directory, its projection cache file, and its rows in
   the context overview shards (the search index cache).

When the backup box is unchecked, the copy step is skipped and nothing is left
on disk — the deletion becomes a real purge that no backup can undo.

The plugin page's **Backups** block lists those copies and restores one with a
button; see [Restoring from the UI](#restoring-from-the-ui).

The session that is serving the click is refused — the Host half compares the
request against `DSH_SESSION_ID` and answers `409`. A session id that the
persistence layer does not know answers `404`.

## Request shape

`POST /dsh-session-revenant/delete`

```jsonc
{ "sessionId": "session-…", "backup": true }   // backup defaults to true
```

The response is `{ ok: true, sessionId, backupDir, removed, prunedShards }`,
where `backupDir` is `null` when the backup box was unchecked.

`POST /dsh-session-revenant/size`

```jsonc
{ "sessionId": "session-…" }
```

The response is `{ ok: true, sessionId, sessionBytes, files, backupBytes, parts }`:
`sessionBytes` is everything the deletion frees, `files` its file count, and
`backupBytes` is what the backup would actually write — the session log without
the derived projection cache, so it is smaller than `sessionBytes`. Sizes are
measured with `lstat` + a recursive walk; symlinks are counted once, never
followed. Any other suffix under the prefix answers `404 unknown action`.

## Restart

The desktop application builds its own `应用` menu in the Electron main process
and gates a *Restart app and Host* entry behind a development build; the Web UI
receives no IPC channel for it. This bundle therefore restarts the application
from the Host process, which does live inside that application:

1. The sidebar-foot control opens a confirmation dialog.
2. `POST /dsh-session-revenant/restart` with `{}` returns
   `{ ok: true, appPid, executable, helper, watchdogMs, delayMs }` immediately.
3. The Host writes a **Node** helper to the temp directory and starts it detached
   with `process.execPath` in `ELECTRON_RUN_AS_NODE` mode.
4. The helper first parks a watchdog (the same script with `--watch`), then stops
   the main process by pid, and finally stops a Host process that outlived it.
   Only then does it start the executable again.
5. The watchdog relaunches the executable after `watchdogMs` only when no process
   of that image is left, so a helper that does not survive stopping its own
   parent still leaves a working application behind.

### Why the main process and the Host are stopped separately

`taskkill /T` (the whole tree) would also kill the helper: the helper is a
descendant of the Host, which is a descendant of the main process, so a tree kill
stops the one process that is supposed to launch the application again.

The Host therefore stops the main process without `/T`, waits for the tree to
collapse, and kills the Host by pid only if it is still alive. That last step
matters: a Host that survives keeps the relaunched application waiting, and the
symptom is a window that only appears after clicking the tray icon — the new main
process has created its tray icon but not its window, because the backend never
reaches `ready`.


### Why not PowerShell

The first version wrote a `.ps1` helper and started `powershell.exe -File`. On a
machine where a security product blocks script hosts, that process starts, exits
with code 0 and runs none of the script — no error, no restart, and every retry
answered `409` because the in-process guard had already latched. The evidence was
five stale `.ps1` helpers in the temp directory with the application still up. A
Node child process runs in that environment, and Node can stop and start a
process without any script host, so the helper is `.mjs`.

Everything destructive happens after the initial sleep: a helper that is killed
early leaves the application running, never half-closed. Running turns are
interrupted; session history is already on disk and returns with the app.

Override the helper directory with `DSH_SESSION_REAPER_RESTART` (defaults to the
system temp directory). The route answers `501` outside a Windows desktop build
and `409` while a restart is inside the 30 second guard window.

### Showing or hiding the controls

Both sidebar controls are optional. The bundle's page in Plugin Manager carries
three switches, **Show the "Reload page" button**, **Show the "Restart app"
button** and **Delete backups older than 7 days**, backed by:

- `GET /dsh-session-revenant/config` → `{ ok: true, config: { restartAction, reloadAction, backupDir, autoClean }, backupRoot, defaultBackupRoot }`
- `POST /dsh-session-revenant/config` with `{ "restartAction": false }` (or
  `reloadAction`, `backupDir`, `autoClean`) → the stored configuration plus
  `backupRoot` and `autoCleanDays`.

The values live in `settings.json` under `$DSH_HOME/.session_reaper` (or
`~/.dsh/.session_reaper` when `DSH_HOME` is unset), not in the profile patch.
Hidden, the Client half renders nothing in `sidebar.footer.action`; the
registration itself stays, so switching it back shows the control again on the
next page load. Override the directory with `DSH_SESSION_REAPER_HOME`.

The footer slot is a horizontal flex row, and the slot node itself is
`display: contents`, so the plugin stylesheet turns the parent into a column
whenever one of these controls is present — reload above restart, in the order
their `order` values say.

### Retention

With `autoClean` on, the Host runs `pruneOldBackups()` once 20 seconds after the
plugin loads and then every six hours, removing directories in the active backup
root whose `meta.json` `createdAt` (falling back to the directory mtime) is older
than seven days. The legacy default root is never swept: those copies predate the
feature and disappear only when deleted by hand. `POST
/dsh-session-revenant/cleanup` runs the same sweep on demand and takes an optional
`{ "days": n }`.

### Reloading instead of restarting

`Reload page` calls `window.location.reload()` and nothing else: it rebuilds
every derived view (session list, search index, projections) from the Host in
about a second, and it does not interrupt a running turn. A real restart is only
needed when the process itself must be replaced.

## Backup

Default: `<DSH_HOME>/dsh-session-backups/<sessionId>-<timestamp>/`. The directory
holds the session log directory and a `meta.json` manifest that records the
original path of every part and the workspace the session was attached to. That
manifest, not a copy of the registry, is what makes a restore exact.

Two things are deliberately left out. The projection cache is derived from the
log, rebuilt on the first open, and was usually the second-largest item in a copy
(10–20% of it here). `storages/workspace.json` is never read back on restore —
the manifest already carries the workspace path — and it changes with every
session, so copying it only bought a stale snapshot. A backup now costs about
what the conversation itself costs.

The manifest also records `archived` and `pinned`, read from the registry-global
id sets (`global.archivedSessionIds` / `global.pinnedSessionIds` in
`storages/workspace.json`) before the detach clears them. A restore attaches the
session to its workspace first, then asks the registry to pin and archive it
again. Both steps are best-effort: the registry refuses a session it cannot
validate, so the response carries `flags` (what actually came back) and
`problems` (one line per refusal) instead of failing the whole restore.

Three things decide the root, in this order:

1. **Backup directory** — the absolute path typed into the plugin page's
   Settings block, stored as `backupDir` in `settings.json`. An empty field means
   "use the default".
2. `DSH_SESSION_DELETE_BACKUP`, kept so an older setup keeps working.
3. `<DSH_HOME>/dsh-session-backups`.

The plugin never writes inside the application installation directory, only into
the DSH data directory (or wherever the user points it), so an application update
cannot take the backups with it. The name is ASCII on purpose: the previous
default was `<DSH_HOME>/../备份/session-delete`, which put a Chinese folder name in
the user's home directory and left the backups outside the data directory
entirely. Backups written by that older version are still listed, restored and
deleted — they are read from the legacy root as well and marked
`from the older folder` in the page.

Each backup also carries a `meta.json` manifest:

```json
{
  "version": 1,
  "sessionId": "session-…",
  "createdAt": "2026-11-21T12:45:00.000Z",
  "workspacePath": "C:\\…\\default-workspace",
  "parts": [{ "name": "session-…", "source": "…\\sessions\\--…--\\session-…" }]
}
```

`parts[].source` is the absolute path the copy came from, which is what makes a
restore exact: without it the plugin could only guess which project bucket the
session belonged to.

Next to it sits `context.json`, and it exists for the session title. A title is
not in the log header — it is a row in
`storages/dsh-context/overview-cache.v3/shard-*.json`, cached by the context
plugin, and deletion prunes that row. A restore that only copied the log back
therefore left the session listed as *unnamed* until it was opened once. The row
is captured at backup time (`context-index.js`) and written back on restore; a
missing shard is ignored, because the index rebuilds itself.

### Restoring from the UI

The plugin page's **Backups** block (`GET /dsh-session-revenant/backups`) lists
every directory under the backup root, newest first. **Restore**
(`POST /dsh-session-revenant/restore` with `{ backup: "<directory name>" }`) copies
each part back to its recorded `source`, then attaches the session again with
`workspaceRegistry.resolveByPath(workspacePath)` (creating the workspace row when
it is gone) and `workspace.attachSession(sessionId)`. The Client half reloads the
page about a second later, so the restored row appears in the sidebar without a
manual refresh.

Refusals, all `409`:

- the session already exists in `sessionPersistence`, or the session log directory
  is already on disk — a log is never overwritten;
- the backup has no `meta.json`, or none of its part files are present.

The projection cache under `storages/session_projcache` is the one exception: it
is derived from the log and rebuilt on demand, so a restore overwrites a stale
copy instead of refusing. That matters in practice, because an Agent that was
still attached when the row was deleted can flush its projection a second later
and bring the file back — refusing on it used to block a restore that had every
right to succeed. The delete path now also sweeps that file once more shortly
after it returns, so the two do not race.

A backup without a manifest (an older copy, or a folder made by hand) is still
listed, marked `restorable: false`, and its button is disabled.

Restoring does not rebuild the context-overview shards that the delete pruned;
the search index picks the session up again on its next rebuild. Reload the page
after a restore to see the session in the sidebar.

### Deleting a backup

Each row also carries **Delete** (`POST /dsh-session-revenant/discard` with
`{ backup: "<directory name>" }`). The confirmation dialog names the backup and
the bytes it is about to free, then the whole backup directory is removed with
`fs.rm(…, { recursive: true, force: true })`.

This is the only irreversible action in the plugin: the conversation is already
gone, and after this its last copy is gone too. The route refuses anything that
is not a direct child of a known backup root (`400`), reports a missing directory
as `404`, and answers `{ backupId, bytes, files }` on success. The row disappears
from the list immediately and the list is reloaded from disk.

## Languages

Every string the user sees is registered twice with the Host locale service —
once under `en`, once under `zh` — and the Client half binds the dictionary for
the language DSH is running in. Nothing is hard-coded in the components.

That includes failures. The Host answers `{ ok: false, error, code }`; `error` is
an English developer message and `code` is a stable identifier such as
`session-exists` or `manifest-missing`. The Client half looks up
`error.code.<code>` and only falls back to the raw message when it does not know
the code, so a Chinese UI never shows `That session already exists; nothing was
restored.` A code may carry `{detail}` where the message adds a path.

Adding a language means one `ctx.locale.register('dsh-session-revenant', '<tag>',
{…})` block in `client.js` and a `locale/<tag>.json` for the plugin page title,
description and detail page.

## Limitations

- Sub-sessions forked from the deleted session are not removed; they are
  independent sessions.
- The dialog is plain DOM appended to `document.body`; it does not use a native
  `confirm()` (so the checkbox can be offered) and it is not rendered inside the
  menu item — closing the menu unmounts that React tree and would take the
  dialog with it.
- The size readout is a snapshot taken when the dialog opened; a session that is
  still being written can grow before you confirm.
- A full page reload happens after success, to drop stale derived views.
- Session search results captured in memory by other open tabs stay stale until
  those tabs reload.
- A session whose work is running in another Harness process is removed from
  this profile's registry; that other process keeps its own handle until it
  exits.
- Restart is Windows-only. It stops the whole application, so unsent composer
  text and any in-flight turn are lost; the helper runs `taskkill.exe` and
  `tasklist.exe` from `PATH`.
- A restore refuses to overwrite: if the session directory or the projection
  cache file is already on disk, nothing is restored and the request answers
  `409`. Remove the leftover first.
- A restore lists and restores local directories only; a backup copied to
  another machine keeps absolute paths from the machine it was written on, so
  those `parts[].source` paths must still make sense there.
- Deleting a backup cannot be undone and is not confirmed by anything but the
  dialog: the session it belongs to was already removed, so no other copy exists.
- Reloading the page drops unsent composer text and the current scroll position;
  it does not interrupt a running turn.
