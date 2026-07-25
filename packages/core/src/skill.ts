export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Scope, Stream, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { EventV2 } from "./event"
import { Watcher } from "./filesystem/watcher"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

type DirectoryWatch = {
  readonly configured: string
  readonly canonical: string
  readonly unsubscribe: Effect.Effect<void>
}

type CacheEntry = {
  readonly revision: number
  readonly skills: Info[]
}

const contains = (directory: string, file: string) => {
  const relative = path.relative(directory, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const watcher = yield* Watcher.Service
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, CacheEntry>()
    const revisions = new Map<string, number>()
    const watches = new Map<string, DirectoryWatch>()

    const invalidate = (key: string) => {
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      cache.delete(key)
    }

    const reconcile = Effect.fn("SkillV2.reconcile")(function* (sources: readonly Source[]) {
      const desired = new Map<string, DirectorySource>()
      for (const source of sources) {
        if (source.type === "directory") desired.set(Source.key(source), source)
      }

      for (const [key, watch] of watches) {
        if (desired.has(key)) continue
        yield* watch.unsubscribe
        watches.delete(key)
        invalidate(key)
      }

      for (const [key, source] of desired) {
        const canonical = yield* fs.realPath(source.path).pipe(Effect.catch(() => Effect.succeed(source.path)))
        const current = watches.get(key)
        if (current?.configured === source.path && current.canonical === canonical) continue
        if (current) {
          yield* current.unsubscribe
          watches.delete(key)
          invalidate(key)
        }
        const unsubscribe = yield* watcher.subscribe(canonical).pipe(Scope.provide(scope))
        watches.set(key, { configured: source.path, canonical, unsubscribe })
      }
    })

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
      finalize: (draft) => reconcile(draft.list()),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return skills
    })

    yield* events.subscribe(Watcher.Event.Updated).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          const belongsToLocation =
            !event.location ||
            (event.location.directory === location.directory && event.location.workspaceID === location.workspaceID)
          if (!belongsToLocation) return
          for (const [key, watch] of watches) {
            if (!contains(watch.configured, event.data.file) && !contains(watch.canonical, event.data.file)) continue
            invalidate(key)
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    const cached = Effect.fn("SkillV2.cached")(function* (source: Source) {
      const key = Source.key(source)
      while (true) {
        const revision = revisions.get(key) ?? 0
        const current = cache.get(key)
        if (current?.revision === revision) return current.skills
        const skills = yield* load(source)
        if ((revisions.get(key) ?? 0) !== revision) continue
        cache.set(key, { revision, skills })
        return skills
      }
    })

    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const loaded = yield* cached(source)
        for (const skill of loaded) skills.set(skill.name, skill)
      }
      return Array.from(skills.values())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SkillDiscovery.node, FSUtil.node, Watcher.node, EventV2.node, Location.node],
})
