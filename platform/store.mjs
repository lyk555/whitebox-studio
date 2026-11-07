// Projects on disk. Every write goes through a temporary file and a rename, so a crash can never leave
// half a project behind.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { ROOT } from './config.mjs'

export const PROJECTS_DIR = join(ROOT, 'projects')

// Sync clients and virus scanners hold files open for a moment on Windows, which fails a rename.
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES'])

export async function replaceFile(from, to) {
  for (let wait = 50; ; wait *= 2) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!LOCKED.has(error.code) || wait > 3200) throw error
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

export async function writeAtomic(path, data) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, data)
  try {
    await replaceFile(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

const assertId = id => {
  if (!/^[a-z0-9_-]{1,40}$/.test(id)) throw new Error(`项目编号不合法：${id}`)
  return id
}

export const projectDir = id => join(PROJECTS_DIR, assertId(id))
export const sceneDir = (projectId, sceneId) => join(projectDir(projectId), 'scenes', sceneId)
export const castDir = (projectId, castId) => join(projectDir(projectId), 'cast', castId)

// Where a project's own file sits, refusing anything that climbs out of the project.
export function insideProject(projectId, relative) {
  const base = projectDir(projectId)
  const path = normalize(join(base, relative))
  if (isAbsolute(relative) || !path.startsWith(base + sep)) throw new Error(`路径不合法：${relative}`)
  return path
}

export async function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return []
  const names = await readdir(PROJECTS_DIR)
  const projects = await Promise.all(names.map(name => readProject(name).catch(() => null)))
  return projects.filter(project => project && !project.removedAt).sort((a, b) => b.updatedAt - a.updatedAt)
}

// Out of the library but untouched on disk: these folders hold pictures that were paid for, and a sync
// client can hold a whole folder open for minutes, so nothing here depends on moving one.
export async function removeFromLibrary(id) {
  const project = await readProject(id)
  project.removedAt = Date.now()
  await writeProject(project)
}

// Every interaction is filmed. Projects from when the model chose which get filmed are brought up to that
// here, so nothing downstream has to know there ever was a choice. The read-only demo is finished as it is.
export function everyInteractionFilmed(project) {
  if (project.readonly) return project
  for (const scene of project.scenes ?? []) {
    for (const beat of scene.beats ?? []) {
      beat.performed = true
      beat.action ||= `手和${beat.objectName}的特写：${beat.objective}。`
    }
  }
  return project
}

export async function readProject(id) {
  return everyInteractionFilmed(JSON.parse(await readFile(join(projectDir(id), 'project.json'), 'utf8')))
}

export async function writeProject(project) {
  await mkdir(projectDir(project.id), { recursive: true })
  project.updatedAt = Date.now()
  await writeAtomic(join(projectDir(project.id), 'project.json'), JSON.stringify(project, null, 2))
  return project
}

export async function createProject({ id, title = '未命名故事', story = '', ...rest }) {
  const project = { id: id ?? `p${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, title, story, style: '', cast: [], scenes: [], provider: 'mock', createdAt: Date.now(), ...rest }
  return writeProject(project)
}
