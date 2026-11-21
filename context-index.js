/**
 * The context overview shards are where the sidebar reads a session title from.
 *
 * A session's title is not in the log header: it is a row in one of the
 * `overview-cache.v3/shard-*.json` files, cached by the context plugin. Deleting
 * a session prunes that row, so a restore that only copies the log back leaves
 * the session listed as "unnamed" until somebody opens it once and the row is
 * rebuilt. These two helpers carry the row through a backup and put it back.
 *
 * Nothing here is authoritative: a shard that refuses to parse, a row that is
 * already present, or a missing shard all degrade to "no title yet", never to a
 * failed restore.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** The session id behind one overview-cache entry. */
export function idOfEntry(entry) {
  return entry?.materialization?.facts?.id ?? entry?.id ?? entry?.sessionId
}

/**
 * Find the context overview row for one session.
 * @param home - DSH home directory.
 * @param sessionId - session to look for.
 * @returns the shard name and the row, or `null` when no shard carries it.
 */
export async function captureContextEntry(home, sessionId) {
  const directory = path.join(home, 'storages', 'dsh-context', 'overview-cache.v3')
  let names = []
  try {
    names = await fs.readdir(directory)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let document
    try {
      document = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
    } catch {
      continue
    }
    const sessions = document?.sessions
    if (!Array.isArray(sessions)) continue
    const entry = sessions.find(row => idOfEntry(row) === sessionId)
    if (entry !== undefined) return { shard: name, sessionId, entry }
  }
  return null
}

/**
 * Put a captured overview row back into its shard.
 * @param home - DSH home directory.
 * @param sessionId - session the row belongs to.
 * @param record - the captured `{ shard, entry }`.
 * @returns the shard name when the row was written, `null` when it could not be.
 */
export async function restoreContextEntry(home, sessionId, record) {
  const shard = typeof record?.shard === 'string' ? record.shard : ''
  const entry = record?.entry
  if (shard === '' || !/^[A-Za-z0-9._-]+\.json$/.test(shard)) return null
  if (entry === null || typeof entry !== 'object') return null
  if (idOfEntry(entry) !== sessionId) return null
  const directory = path.join(home, 'storages', 'dsh-context', 'overview-cache.v3')
  const file = path.join(directory, shard)
  let document
  try {
    document = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    // The shard was pruned or removed entirely; the index rebuilds by itself.
    return null
  }
  const sessions = document?.sessions
  if (!Array.isArray(sessions)) return null
  if (sessions.some(row => idOfEntry(row) === sessionId)) return shard
  sessions.push(entry)
  document.savedAt = Date.now()
  const temporary = `${file}.tmp`
  await fs.writeFile(temporary, JSON.stringify(document), 'utf8')
  await fs.rename(temporary, file)
  return shard
}
