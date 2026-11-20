/**
 * Stage and pack the optional manual-acceptance fixture.
 *
 * The source under `fixtures/instructions/` keeps candidate files named
 * `AGENTS.md.template` instead of `AGENTS.md`: a real candidate name inside
 * this repository would be picked up by nested instruction discovery during
 * ordinary development, and a committed `.git` directory is impossible. A
 * staged copy therefore strips `.template` and writes its own `.git/HEAD`
 * marker, outside the tracked tree.
 *
 * Commands:
 *   check              validate the source without writing anything
 *   prepare            stage to `.tmp/instructions-fixture`
 *   stage <dir>        stage to an explicit directory
 *   pack               stage to `dist/` and create the release zip + checksum
 *
 * @module dsh-instructions-policy/fixture
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SOURCE = join(REPO, 'fixtures', 'instructions')
const DEFAULT_OUT = join(REPO, '.tmp', 'instructions-fixture')
const DEFAULT_DIST = join(REPO, 'dist')
const NAME = 'instructions-fixture'
const TEMPLATE_SUFFIX = '.template'
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const REQUIRED = [
  'README.md',
  'VERIFY.md',
  'verify-state.mjs',
  'CUSTOM_ROOT.md',
  'sub/deep/note.txt',
  'sub/advanced/local/note.txt',
  'sub/advanced/escape/note.txt',
]
const EXPECTED_MARKERS = [
  'ROOT_MARKER_111',
  'CLAUDE_MARKER_555',
  'CUSTOM_MARKER_444',
  'SUB_MARKER_222',
  'DEEP_MARKER_333',
  'LOCAL_AGENTS_MARKER_666',
  'LOCAL_OVERLAY_MARKER_667',
  'ESCAPE_MARKER_777',
]
const DEDUPE_PAIR = new Set(['sub/AGENTS.md.template', 'sub/CLAUDE.md.template'])

const MARKER_RE = /[A-Z][A-Z0-9_]*_MARKER_\d+/g

/** Recursively list files, skipping any `.git` directory. */
async function walk(directory) {
  const entries = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue
    const absolute = join(directory, entry.name)
    const rel = relative(SOURCE, absolute).split(sep).join('/')
    if (entry.isDirectory()) {
      entries.push(...await walk(absolute))
    } else if (entry.isFile()) {
      entries.push({ absolute, rel, name: entry.name })
    }
  }
  return entries
}

/** Final file name after removing the template suffix. */
function finalName(name) {
  return name.endsWith(TEMPLATE_SUFFIX) ? name.slice(0, -TEMPLATE_SUFFIX.length) : name
}

/** Whether one staged path stays inside the repository or the OS temp root. */
function isSafeTarget(target) {
  const normalized = resolve(target)
  const roots = [REPO, resolve(tmpdir())]
  return roots.some((root) => {
    const rel = relative(root, normalized)
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
  })
}

/** Validate the source tree without writing anything. */
async function check() {
  const entries = await walk(SOURCE)
  const errors = []
  const files = entries.filter(entry => entry.rel !== '')
  const names = new Set(files.map(entry => entry.rel))
  const templates = []

  try {
    await stat(join(SOURCE, '.git'))
    errors.push('.git must be generated, not stored in the source')
  } catch {
    // Expected: the staged copy creates the marker.
  }

  try {
    await stat(join(REPO, 'fixtures', 'AGENTS.md'))
  } catch {
    errors.push('missing fixtures/AGENTS.md parent guard')
  }

  for (const file of files) {
    if (CANDIDATES.includes(file.name)) {
      errors.push(`${file.rel}: candidate files must use the ${TEMPLATE_SUFFIX} suffix`)
      continue
    }
    if (file.name.endsWith(TEMPLATE_SUFFIX)) {
      const staged = finalName(file.name)
      if (!CANDIDATES.includes(staged)) {
        errors.push(`${file.rel}: ${TEMPLATE_SUFFIX} is only valid on a candidate name`)
      } else {
        templates.push(file.rel)
      }
    }
  }

  for (const required of REQUIRED) {
    if (!names.has(required)) errors.push(`missing required file: ${required}`)
  }

  const subAgents = files.find(file => file.rel === 'sub/AGENTS.md.template')
  const subClaude = files.find(file => file.rel === 'sub/CLAUDE.md.template')
  if (subAgents === undefined || subClaude === undefined) {
    errors.push('the dedupe case needs sub/AGENTS.md.template and sub/CLAUDE.md.template')
  } else {
    const left = (await readFile(subAgents.absolute, 'utf8')).trim()
    const right = (await readFile(subClaude.absolute, 'utf8')).trim()
    if (left !== right) errors.push('sub/CLAUDE.md.template must repeat sub/AGENTS.md.template for the dedupe case')
  }

  // Only instruction content carries markers; docs and the checker mention the
  // marker names on purpose, so scanning them would report false duplicates.
  const markerFiles = new Map()
  for (const file of files) {
    const staged = finalName(file.name)
    if (!CANDIDATES.includes(staged) && staged !== 'CUSTOM_ROOT.md') continue
    const content = await readFile(file.absolute, 'utf8')
    for (const marker of new Set(content.match(MARKER_RE) ?? [])) {
      const owners = markerFiles.get(marker) ?? []
      owners.push(file.rel)
      markerFiles.set(marker, owners)
    }
  }
  for (const marker of EXPECTED_MARKERS) {
    if (!markerFiles.has(marker)) errors.push(`missing marker in instruction files: ${marker}`)
  }
  for (const [marker, owners] of markerFiles) {
    if (owners.length > 1 && !owners.every(owner => DEDUPE_PAIR.has(owner))) {
      errors.push(`marker ${marker} appears in multiple files: ${owners.join(', ')}`)
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`fixture: ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`fixture: ok (${files.length} source files, ${templates.length} templates, ${markerFiles.size} markers)`)
}

/** Stage one runnable copy with real names and a generated project-root marker. */
async function stage(outDir, options = {}) {
  const target = resolve(outDir)
  if (!isSafeTarget(target)) {
    throw new Error(`refusing to stage outside the repository or the OS temp root: ${target}`)
  }
  if (target === REPO || target === resolve(homedir())) {
    throw new Error(`refusing to stage into ${target}`)
  }

  let exists = true
  try {
    const info = await stat(target)
    if (!info.isDirectory()) throw new Error(`not a directory: ${target}`)
  } catch (error) {
    if (error && error.code === 'ENOENT') exists = false
    else throw error
  }
  if (exists) {
    const contents = await readdir(target)
    if (contents.length > 0) {
      if (options.force !== true) {
        throw new Error(`refusing to overwrite non-empty directory: ${target} (pass --force)`)
      }
      await rm(target, { recursive: true, force: true })
    }
  }

  await mkdir(target, { recursive: true })
  for (const entry of await walk(SOURCE)) {
    const rel = entry.rel.split('/').map(finalName).join('/')
    const destination = join(target, ...rel.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(entry.absolute, destination)
  }

  // The marker is a file (not an empty directory) so zip tools keep it. DSH
  // only needs the entry to exist; this is deliberately not a usable repository.
  await mkdir(join(target, '.git'), { recursive: true })
  await writeFile(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return target
}

/** Stage the default runnable copy and print where to open the workspace. */
async function prepare(outDir = DEFAULT_OUT) {
  const target = await stage(outDir, { force: true })
  console.log(`fixture: ${target}`)
  console.log(`workspace: ${join(target, 'sub')}`)
  console.log(`check: cd "${join(target, 'sub')}" && node ../verify-state.mjs --expect A`)
}

/** Create the release zip and its SHA-256 file. */
async function pack(distDir = DEFAULT_DIST) {
  const dist = resolve(distDir)
  if (!isSafeTarget(dist)) throw new Error(`refusing to pack outside the repository: ${dist}`)
  const target = await stage(join(dist, NAME), { force: true })
  const zipPath = join(dist, `${NAME}.zip`)
  await rm(zipPath, { force: true })

  let zipped = spawnSync('zip', ['-qr', `${NAME}.zip`, NAME], { cwd: dist, encoding: 'utf8' })
  if (zipped.error !== undefined || zipped.status !== 0) {
    // Windows without zip(1): Compress-Archive is available in Windows
    // PowerShell and PowerShell 7. CI uses zip(1) on Ubuntu.
    const script = `Compress-Archive -LiteralPath '${NAME}' -DestinationPath '${NAME}.zip' -Force`
    for (const shell of ['pwsh', 'powershell']) {
      zipped = spawnSync(shell, ['-NoProfile', '-Command', script], { cwd: dist, encoding: 'utf8' })
      if (zipped.error === undefined && zipped.status === 0) break
    }
  }
  if (zipped.error !== undefined || zipped.status !== 0) {
    throw new Error(`cannot create ${zipPath}: install zip(1) or use PowerShell Compress-Archive`)
  }

  const bytes = await readFile(zipPath)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const checksum = join(dist, `${NAME}.zip.sha256`)
  await writeFile(checksum, `${hash}  ${NAME}.zip\n`)
  console.log(`zip: ${zipPath}`)
  console.log(`sha256: ${checksum}`)
  console.log(`staged: ${target}`)
}

/** Print the command-line contract. */
function usage() {
  console.log(`Usage: node scripts/fixture.mjs <check|prepare|stage|pack> [options]

  check                 validate fixtures/instructions without writing
  prepare [--out dir]   stage to .tmp/instructions-fixture and print the workspace
  stage <dir> [--force] stage a runnable copy to an explicit directory
  pack [--out dir]      stage to dist/ and create the zip + sha256`)
}

async function main() {
  const [command = 'check', ...rest] = process.argv.slice(2)
  if (command === '--help' || command === '-h' || command === 'help') {
    usage()
    return
  }
  const force = rest.includes('--force')
  const outAt = rest.indexOf('--out')
  const out = outAt >= 0 ? rest[outAt + 1] : undefined
  switch (command) {
    case 'check':
      await check()
      return
    case 'prepare':
      await prepare(out === undefined ? DEFAULT_OUT : resolve(out))
      return
    case 'stage': {
      const dir = rest.find(argument => !argument.startsWith('--') && argument !== out)
      if (dir === undefined) throw new Error('stage requires a directory')
      const target = await stage(resolve(dir), { force })
      console.log(`fixture: ${target}`)
      return
    }
    case 'pack':
      await pack(out === undefined ? DEFAULT_DIST : resolve(out))
      return
    default:
      usage()
      process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(`fixture: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
