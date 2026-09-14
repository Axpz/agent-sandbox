import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeConfig, Source } from '../src/checkpoint/model'
import { execute } from '../src/checkpoint/worker'

let directory: string
let runtime: RuntimeConfig
let source: Source
let commands: string[][]
let paused: boolean
let stopped: boolean
let failSave: boolean
let id: string
const rootID = 'b'.repeat(64)

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'xsphere-checkpoint-test-')))
  await Bun.write(join(directory, 'runsc'), 'pinned runtime')
  runtime = {
    runtimeClassName: 'gvisor',
    nodeName: 'node-a',
    runscBinary: join(directory, 'runsc'),
    runscSha256: createHash('sha256').update('pinned runtime').digest('hex'),
    runscRoot: join(directory, 'state'),
    artifactRoot: directory,
    workerImage: 'test@sha256:abc',
    timeoutSeconds: 30,
  }
  source = {
    namespace: 'sandbox',
    sandboxName: 'example',
    sandboxUID: crypto.randomUUID(),
    podName: 'example',
    podUID: crypto.randomUUID(),
    nodeName: 'node-a',
    containerID: 'a'.repeat(64),
    image: `example@sha256:${'c'.repeat(64)}`,
  }
  id = crypto.randomUUID()
  commands = []
  paused = false
  stopped = false
  failSave = false
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function command(_config: RuntimeConfig, ...args: string[]): Promise<string> {
  commands.push(args)
  if (args[0] === 'list') {
    if (stopped) return 'null'
    return JSON.stringify(
      [rootID, source.containerID].map((containerID) => ({
        id: containerID,
        status: paused ? 'paused' : 'running',
        pid: 123,
        annotations: {
          'io.kubernetes.cri.container-type': containerID === rootID ? 'sandbox' : 'container',
          'io.kubernetes.cri.sandbox-uid': source.podUID,
          'io.kubernetes.cri.sandbox-namespace': source.namespace,
          'io.kubernetes.cri.sandbox-name': source.podName,
        },
      })),
    )
  }
  if (args[0] === 'checkpoint') {
    // This runsc version exits even on some failed saves without --leave-running.
    stopped = true
    if (failSave) throw new Error('disk full')
    const path = args.find((arg) => arg.startsWith('--image-path='))?.slice('--image-path='.length)
    if (!path) throw new Error('missing image path')
    await Bun.write(join(path, 'checkpoint.img'), 'saved kernel')
    await Bun.write(join(path, 'pages.img'), 'saved memory')
    await Bun.write(join(path, 'pages_meta.img'), 'page metadata')
  }
  return ''
}

test('native checkpoint stops the sandbox and can replay the saved manifest after exit', async () => {
  const checkpoint = await execute(runtime, { action: 'save', id, source }, command)
  expect(commands.map((args) => args[0])).toEqual(['list', 'checkpoint'])
  expect(commands[1]).not.toContain('--leave-running')
  expect(stopped).toBe(true)
  expect(checkpoint?.files).toHaveLength(3)
  expect(JSON.parse(await readFile(join(checkpoint?.path ?? '', 'manifest.json'), 'utf8'))).toEqual(
    checkpoint,
  )
  const replay = await execute(runtime, { action: 'save', id, source }, command)
  expect(replay).toEqual(checkpoint)
  expect(commands.filter((args) => args[0] === 'checkpoint')).toHaveLength(1)
})

test('save failure does not publish a manifest or try to restart the original', async () => {
  failSave = true
  await expect(execute(runtime, { action: 'save', id, source }, command)).rejects.toThrow(
    'disk full',
  )
  expect(stopped).toBe(true)
  expect(commands.map((args) => args[0])).toEqual(['list', 'checkpoint'])
  await expect(readFile(join(directory, source.sandboxUID, id, 'manifest.json'))).rejects.toThrow()
})

test('a corrupt artifact cannot pass restore verification', async () => {
  const checkpoint = await execute(runtime, { action: 'save', id, source }, command)
  if (!checkpoint) throw new Error('missing checkpoint')
  await Bun.write(join(checkpoint.path, 'pages.img'), 'corrupt data')
  await expect(execute(runtime, { action: 'verify', checkpoint }, command)).rejects.toThrow(
    'integrity',
  )
})

test('a failed new save leaves the previous successful artifact intact', async () => {
  const checkpoint = await execute(runtime, { action: 'save', id, source }, command)
  if (!checkpoint) throw new Error('missing checkpoint')
  stopped = false
  failSave = true
  await expect(
    execute(runtime, { action: 'save', id: crypto.randomUUID(), source }, command),
  ).rejects.toThrow('disk full')
  expect(await execute(runtime, { action: 'verify', checkpoint }, command)).toEqual(checkpoint)
})

test('node/runtime mismatch and unrelated external freezes are rejected', async () => {
  await expect(
    execute({ ...runtime, nodeName: 'node-b' }, { action: 'save', id, source }, command),
  ).rejects.toThrow('different node')
  await expect(
    execute({ ...runtime, runscSha256: 'd'.repeat(64) }, { action: 'save', id, source }, command),
  ).rejects.toThrow('checksum')
  paused = true
  await expect(execute(runtime, { action: 'save', id, source }, command)).rejects.toThrow(
    'sandbox is not running: paused',
  )
  expect(commands.some((args) => args[0] === 'resume')).toBe(false)
})
