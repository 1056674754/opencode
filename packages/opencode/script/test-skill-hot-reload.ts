#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

const HOST = "127.0.0.1"
const SKILL_ROUTE = "/api/skill"
const SEED_SKILL = "__seed_skill__"
const HOT_RELOAD_SKILL = "__test_hot_reload__"
const POLL_INTERVAL_MS = 200
const HOT_RELOAD_TIMEOUT_MS = 2_000
const READY_TIMEOUT_MS = 30_000
const packageDir = path.resolve(import.meta.dir, "..")

const SkillResponse = z.object({
  data: z.array(z.object({ name: z.string() })),
})

class VerificationError extends Error {
  override readonly name = "VerificationError"
}

type SkillExpectation = {
  readonly endpoint: URL
  readonly name: string
  readonly present: boolean
}

type Result = {
  readonly addMs: number
  readonly deleteMs: number
}

let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
let childStdout = Promise.resolve("")
let childStderr = Promise.resolve("")
let cleanupPromise: Promise<void> | undefined
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-skill-hot-reload-"))
const homeDir = path.join(tempRoot, "home")
const projectDir = path.join(tempRoot, "project")
const configDir = path.join(homeDir, ".config", "opencode")
const skillsDir = path.join(homeDir, ".agents", "skills")
const hotReloadDir = path.join(skillsDir, HOT_RELOAD_SKILL)

async function reserveFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, HOST, () => {
      const address = server.address() as AddressInfo
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function stopChild() {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
  if (stopped) return
  child.kill("SIGKILL")
  await child.exited
}

function cleanup() {
  cleanupPromise ??= (async () => {
    await stopChild()
    await rm(tempRoot, { recursive: true, force: true })
  })()
  return cleanupPromise
}

async function waitForReady(url: URL, process: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const deadline = performance.now() + READY_TIMEOUT_MS
  let lastFailure = "no response"
  while (performance.now() < deadline) {
    if (process.exitCode !== null) throw new VerificationError(`server exited with code ${process.exitCode}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastFailure = `HTTP ${response.status}`
    } catch (cause) {
      lastFailure = cause instanceof Error ? cause.message : String(cause)
    }
    await Bun.sleep(POLL_INTERVAL_MS)
  }
  throw new VerificationError(`server was not ready within ${READY_TIMEOUT_MS}ms: ${lastFailure}`)
}

async function getSkillNames(endpoint: URL) {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) })
  if (!response.ok) throw new VerificationError(`${SKILL_ROUTE} returned HTTP ${response.status}`)
  return new Set(SkillResponse.parse(await response.json()).data.map((skill) => skill.name))
}

async function waitForSkill(expectation: SkillExpectation) {
  const started = performance.now()
  const deadline = started + HOT_RELOAD_TIMEOUT_MS
  while (performance.now() < deadline) {
    const names = await getSkillNames(expectation.endpoint)
    if (names.has(expectation.name) === expectation.present) return Math.round(performance.now() - started)
    await Bun.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - performance.now())))
  }
  const state = expectation.present ? "appear" : "disappear"
  throw new VerificationError(`${expectation.name} did not ${state} within ${HOT_RELOAD_TIMEOUT_MS}ms`)
}

async function run(): Promise<Result> {
  await mkdir(projectDir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  await mkdir(path.join(skillsDir, SEED_SKILL), { recursive: true })
  await Bun.write(
    path.join(skillsDir, SEED_SKILL, "SKILL.md"),
    `---\nname: ${SEED_SKILL}\ndescription: Seed skill for hot-reload verification.\n---\n\n# Seed skill\n`,
  )
  await Bun.write(
    path.join(configDir, "opencode.json"),
    JSON.stringify({ snapshot: false, skills: { paths: ["~/.agents/skills"] } }),
  )

  const modelsFixture = path.join(packageDir, "test", "tool", "fixtures", "models-api.json")
  const buildArgs = ["bun", "run", "script/build.ts", "--single", "--skip-embed-web-ui", "--skip-install"]
  console.log(`Build: MODELS_DEV_API_JSON=${modelsFixture} OPENCODE_CHANNEL=latest ${buildArgs.join(" ")}`)
  const build = Bun.spawn(buildArgs, {
    cwd: packageDir,
    env: { ...process.env, MODELS_DEV_API_JSON: modelsFixture, OPENCODE_CHANNEL: "latest" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const buildExit = await build.exited
  if (buildExit !== 0) throw new VerificationError(`binary build exited with code ${buildExit}`)

  const target = `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  const executable = process.platform === "win32" ? "opencode.exe" : "opencode"
  const binary = path.join(packageDir, "dist", target, "bin", executable)
  const port = await reserveFreePort()
  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCODE_TEST_HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_STATE_HOME: path.join(homeDir, ".local", "state"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_SERVER_USERNAME: "",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  }
  child = Bun.spawn([binary, "serve", "--hostname", HOST, "--port", String(port)], {
    cwd: projectDir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  childStdout = new Response(child.stdout).text()
  childStderr = new Response(child.stderr).text()

  const baseUrl = new URL(`http://${HOST}:${port}`)
  await waitForReady(new URL("/global/health", baseUrl), child)
  const skillEndpoint = new URL(SKILL_ROUTE, baseUrl)
  skillEndpoint.searchParams.set("location[directory]", projectDir)

  await waitForSkill({ endpoint: skillEndpoint, name: SEED_SKILL, present: true })
  const initial = await getSkillNames(skillEndpoint)
  if (!initial.has(SEED_SKILL)) throw new VerificationError(`initial list did not contain ${SEED_SKILL}`)
  if (initial.has(HOT_RELOAD_SKILL))
    throw new VerificationError(`initial list unexpectedly contained ${HOT_RELOAD_SKILL}`)

  await mkdir(hotReloadDir, { recursive: true })
  await Bun.write(
    path.join(hotReloadDir, "SKILL.md"),
    `---\nname: ${HOT_RELOAD_SKILL}\ndescription: Skill created during hot-reload verification.\n---\n\n# Hot reload skill\n`,
  )
  const addMs = await waitForSkill({ endpoint: skillEndpoint, name: HOT_RELOAD_SKILL, present: true })

  await rm(hotReloadDir, { recursive: true, force: true })
  const deleteMs = await waitForSkill({ endpoint: skillEndpoint, name: HOT_RELOAD_SKILL, present: false })
  return { addMs, deleteMs }
}

const onSigint = () => {
  void cleanup().finally(() => {
    console.error("FAIL: interrupted by SIGINT; server and isolated temp directories were cleaned up")
    process.exit(1)
  })
}
process.once("SIGINT", onSigint)

let result: Result | undefined
let failure: unknown
try {
  result = await run()
} catch (cause) {
  failure = cause instanceof Error ? cause : new VerificationError(String(cause))
} finally {
  process.off("SIGINT", onSigint)
  try {
    await cleanup()
  } catch (cause) {
    failure ??= cause instanceof Error ? cause : new VerificationError(String(cause))
  }
}

if (failure || !result) {
  console.error(`Server stdout:\n${await childStdout}`)
  console.error(`Server stderr:\n${await childStderr}`)
  console.error(`FAIL: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`)
  process.exit(1)
}

console.log(`PASS: skill hot reload verified through GET ${SKILL_ROUTE}`)
console.log(`Add detected in ${result.addMs}ms; delete detected in ${result.deleteMs}ms`)
process.exit(0)
