import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const subscriptions = new Map<string, number>()
const watcher = Layer.succeed(
  Watcher.Service,
  Watcher.Service.of({
    subscribe: (directory) =>
      Effect.gen(function* () {
        let active = true
        subscriptions.set(directory, (subscriptions.get(directory) ?? 0) + 1)
        const unsubscribe = Effect.sync(() => {
          if (!active) return
          active = false
          const count = subscriptions.get(directory) ?? 0
          if (count === 1) subscriptions.delete(directory)
          if (count > 1) subscriptions.set(directory, count - 1)
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return unsubscribe
      }),
  }),
)
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node, EventV2.node, FSUtil.node]), [
    [SkillDiscovery.node, discovery],
    [Watcher.node, watcher],
    [Location.node, locationLayer],
  ]),
)

async function write(directory: string, name: string, description: string) {
  await fs.mkdir(path.join(directory, name), { recursive: true })
  await fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          const reviewer = yield* agents.get(AgentV2.ID.make("reviewer")).pipe(
            Effect.flatMap((agent) =>
              agent ? Effect.succeed(agent) : Effect.die(new Error("reviewer agent was not registered")),
            ),
          )
          expect(SkillV2.available(yield* skill.list(), reviewer)).toEqual([])
        }),
      ),
    ),
  )

  it.live("invalidates cached directory skills after a watcher event", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const root = path.join(directory, "skills")
        yield* Effect.promise(() => Promise.all([write(root, "alpha", "Alpha"), write(root, "beta", "Beta")]))
        const skill = yield* SkillV2.Service
        const events = yield* EventV2.Service
        yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(root) }))

        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta"])
        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta"])
        yield* Effect.promise(() => write(root, "charlie", "Charlie"))
        const file = path.join(root, "charlie", "SKILL.md")
        yield* events.publish(Watcher.Event.Updated, { file, event: "add" })

        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta", "charlie"])
      }),
    ),
  )

  it.live("keeps directory cache for unrelated watcher events", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const root = path.join(directory, "skills")
        yield* Effect.promise(() => Promise.all([write(root, "alpha", "Alpha"), write(root, "beta", "Beta")]))
        const skill = yield* SkillV2.Service
        const events = yield* EventV2.Service
        yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(root) }))
        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta"])

        yield* Effect.promise(() => write(root, "charlie", "Charlie"))
        yield* events.publish(Watcher.Event.Updated, {
          file: path.join(directory, "unrelated", "SKILL.md"),
          event: "add",
        })

        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta"])
      }),
    ),
  )

  it.live("does not match sibling directory prefixes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const root = path.join(directory, "foo")
        yield* Effect.promise(() => Promise.all([write(root, "alpha", "Alpha"), write(root, "beta", "Beta")]))
        const skill = yield* SkillV2.Service
        const events = yield* EventV2.Service
        yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(root) }))
        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta"])

        yield* Effect.promise(() => write(root, "charlie", "Charlie"))
        yield* events.publish(Watcher.Event.Updated, {
          file: path.join(directory, "foo-bar", "charlie", "SKILL.md"),
          event: "add",
        })

        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta"])
      }),
    ),
  )

  it.live("keeps URL and embedded sources cached across directory events", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const local = path.join(directory, "local")
        const remote = path.join(directory, "remote")
        yield* Effect.promise(() => Promise.all([write(local, "alpha", "Alpha"), write(remote, "remote", "Remote")]))
        pulls = 0
        urls.set("https://example.test/cached/", [AbsolutePath.make(remote)])
        const skill = yield* SkillV2.Service
        const events = yield* EventV2.Service
        yield* skill.transform((editor) => {
          editor.source({ type: "directory", path: AbsolutePath.make(local) })
          editor.source({ type: "url", url: "https://example.test/cached/" })
          editor.source({
            type: "embedded",
            skill: SkillV2.Info.make({
              name: "embedded",
              description: "Embedded",
              location: AbsolutePath.make("/embedded/SKILL.md"),
              content: "# embedded",
            }),
          })
        })
        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "remote", "embedded"])

        yield* Effect.promise(() => write(local, "beta", "Beta"))
        yield* events.publish(Watcher.Event.Updated, {
          file: path.join(local, "beta", "SKILL.md"),
          event: "add",
        })

        expect((yield* skill.list()).map((item) => item.name)).toEqual(["alpha", "beta", "remote", "embedded"])
        expect(pulls).toBe(1)
      }),
    ),
  )

  it.live("unsubscribes directory sources when their transform is disposed", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const root = path.join(directory, "skills")
        yield* Effect.promise(() => fs.mkdir(root, { recursive: true }))
        subscriptions.clear()
        const canonical = yield* Effect.promise(() => fs.realpath(root))
        const skill = yield* SkillV2.Service
        const registration = yield* skill.transform((editor) =>
          editor.source({ type: "directory", path: AbsolutePath.make(root) }),
        )

        expect(subscriptions.get(canonical)).toBe(1)
        yield* registration.dispose
        expect(subscriptions.has(canonical)).toBe(false)
      }),
    ),
  )

  it.live("does not cache a stale load when a watcher event arrives in flight", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const root = path.join(directory, "skills")
        yield* Effect.promise(() => Promise.all([write(root, "alpha", "Alpha"), write(root, "beta", "Beta")]))
        const skill = yield* SkillV2.Service
        const events = yield* EventV2.Service
        const afs = yield* FSUtil.Service
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const originalGlob = afs.glob
        let calls = 0
        const blockedGlob: FSUtil.Interface["glob"] = (pattern, options) =>
          Effect.gen(function* () {
            calls++
            if (calls > 1) return yield* originalGlob(pattern, options)
            const stale = yield* originalGlob(pattern, options)
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return stale
          })
        Object.defineProperty(afs, "glob", { configurable: true, value: blockedGlob })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.defineProperty(afs, "glob", { configurable: true, value: originalGlob })),
        )
        yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(root) }))

        const loading = yield* skill.list().pipe(Effect.forkScoped)
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
        yield* Effect.promise(() => write(root, "charlie", "Charlie"))
        yield* events.publish(Watcher.Event.Updated, {
          file: path.join(root, "charlie", "SKILL.md"),
          event: "add",
        })
        yield* Deferred.succeed(release, undefined)

        expect((yield* Fiber.join(loading)).map((item) => item.name)).toEqual(["alpha", "beta", "charlie"])
        expect(calls).toBe(2)
      }),
    ),
  )
})
