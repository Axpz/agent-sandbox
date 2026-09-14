import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type Checkpoint,
  checkpointSchema,
  type RuntimeConfig,
  runtimeConfigSchema,
  type Source,
  type WorkerRequest,
  workerRequestSchema,
} from './model'

type State = { id: string; status: string; annotations: Record<string, string> }
const files = ['checkpoint.img', 'pages.img', 'pages_meta.img'] as const
type Command = (config: RuntimeConfig, ...args: string[]) => Promise<string>

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function readJSON(path: string): Promise<unknown> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 16_384) throw new Error('invalid checkpoint manifest file')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function boundedOutput(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > limit) throw new Error('runtime output exceeded the safety limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function runsc(config: RuntimeConfig, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(
    [config.runscBinary, `--root=${config.runscRoot}`, '--platform=systrap', ...args],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const timer = setTimeout(() => proc.kill('SIGKILL'), (config.timeoutSeconds - 20) * 1000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      boundedOutput(proc.stdout, 8 * 1024 * 1024),
      boundedOutput(proc.stderr, 64 * 1024),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`runsc ${args[0]} failed (${code}): ${stderr.slice(-2048)}`)
    return stdout
  } finally {
    clearTimeout(timer)
    if (proc.exitCode === null) proc.kill('SIGKILL')
    await proc.exited
  }
}

async function states(config: RuntimeConfig, source: Source, command: Command): Promise<State[]> {
  const list = (JSON.parse(await command(config, 'list', '--format=json')) ?? []) as State[]
  return list.filter(
    (entry) =>
      entry.annotations['io.kubernetes.cri.sandbox-uid'] === source.podUID &&
      entry.annotations['io.kubernetes.cri.sandbox-namespace'] === source.namespace &&
      entry.annotations['io.kubernetes.cri.sandbox-name'] === source.podName,
  )
}

function rootState(list: State[], source: Source): State {
  const root = list.find(
    (entry) => entry.annotations['io.kubernetes.cri.container-type'] === 'sandbox',
  )
  if (!root || !list.some((entry) => entry.id === source.containerID)) {
    throw new Error('runtime identity does not match the selected Pod and container')
  }
  return root
}

function imagePath(config: RuntimeConfig, source: Source, id: string): string {
  return join(config.artifactRoot, source.sandboxUID, id)
}

async function verify(config: RuntimeConfig, expected: Checkpoint): Promise<Checkpoint> {
  const path = imagePath(config, expected.source, expected.id)
  if (path !== expected.path || expected.runscSha256 !== config.runscSha256) {
    throw new Error('checkpoint location or runtime version mismatch')
  }
  if ((await realpath(path)) !== path) throw new Error('checkpoint directory must not be a symlink')
  const manifest = checkpointSchema.parse(await readJSON(join(path, 'manifest.json')))
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error('checkpoint manifest changed')
  for (const name of files) {
    const recorded = manifest.files.find(
      (entry: Checkpoint['files'][number]) => entry.name === name,
    )
    const stat = await lstat(join(path, name))
    if (
      !recorded ||
      !stat.isFile() ||
      stat.size !== recorded.size ||
      (await sha256(join(path, name))) !== recorded.sha256
    ) {
      throw new Error(`checkpoint file failed integrity validation: ${name}`)
    }
  }
  return manifest
}

async function save(
  config: RuntimeConfig,
  request: Extract<WorkerRequest, { action: 'save' }>,
  command: Command,
): Promise<Checkpoint> {
  const { source, id } = request
  const path = imagePath(config, source, id)
  try {
    const previous = checkpointSchema.parse(await readJSON(join(path, 'manifest.json')))
    if (previous.id !== id || JSON.stringify(previous.source) !== JSON.stringify(source))
      throw new Error('saved artifact does not belong to this checkpoint operation')
    return verify(config, previous)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const root = rootState(await states(config, source, command), source)
  if (root.status !== 'running') throw new Error(`sandbox is not running: ${root.status}`)
  const parent = join(config.artifactRoot, source.sandboxUID)
  await mkdir(parent, { mode: 0o700, recursive: true })
  if ((await realpath(parent)) !== parent)
    throw new Error('checkpoint parent must not be a symlink')
  // runsc creates files exclusively. Never overwrite the last good snapshot or
  // retry into a partial directory after an interrupted save.
  await mkdir(path, { mode: 0o700 })
  // Native checkpoint stops the sandbox itself; no external freeze, debug kill,
  // or unfreeze choreography. A failed save may also stop it in this runsc build.
  await command(config, 'checkpoint', '--compression=none', `--image-path=${path}`, root.id)
  const recorded: Checkpoint['files'] = []
  for (const name of files) {
    const file = join(path, name)
    const stat = await lstat(file)
    if (!stat.isFile() || (name !== 'pages.img' && stat.size === 0)) {
      throw new Error(`checkpoint file is missing or incomplete: ${name}`)
    }
    const handle = await open(file, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    recorded.push({ name, size: stat.size, sha256: await sha256(file) })
  }
  const checkpoint: Checkpoint = {
    id,
    source,
    path,
    rootID: root.id,
    runscSha256: config.runscSha256,
    createdAt: new Date().toISOString(),
    files: recorded,
  }
  await writeJSON(join(path, 'manifest.json'), checkpoint)
  return checkpoint
}

export async function execute(
  config: RuntimeConfig,
  request: WorkerRequest,
  command: Command = runsc,
): Promise<Checkpoint | null> {
  if ((await realpath(config.artifactRoot)) !== config.artifactRoot)
    throw new Error('artifact root must not be a symlink')
  if ((await sha256(config.runscBinary)) !== config.runscSha256)
    throw new Error('runsc checksum mismatch')
  const source = 'source' in request ? request.source : request.checkpoint.source
  if (source.nodeName !== config.nodeName) throw new Error('checkpoint belongs to a different node')
  if (request.action === 'save') return save(config, request, command)
  return verify(config, request.checkpoint)
}

if (import.meta.main) {
  try {
    const config = runtimeConfigSchema.parse(JSON.parse(process.env.CHECKPOINT_RUNTIME ?? ''))
    const request = workerRequestSchema.parse(JSON.parse(process.env.CHECKPOINT_REQUEST ?? ''))
    const checkpoint = await execute(config, request)
    await Bun.write('/dev/termination-log', JSON.stringify({ ok: true, checkpoint }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await Bun.write(
      '/dev/termination-log',
      JSON.stringify({ ok: false, error: message.slice(0, 2048) }),
    )
    process.exitCode = 1
  }
}
