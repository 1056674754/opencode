/// <reference path="./parcel-watcher-wrapper.d.ts" />

export * as Watcher from "./watcher"

import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { makeLocationNode } from "../effect/app-node"
import { Cause, Context, Effect, Layer, Scope } from "effect"
import { FileSystemWatcher } from "@opencode-ai/schema/filesystem-watcher"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { lazy } from "../util/lazy"
import { Ignore } from "./ignore"
import { Protected } from "./protected"

declare const OPENCODE_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000

export const Event = FileSystemWatcher.Event

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding)
  } catch {
    return undefined
  }
})

function getBackend(): ParcelWatcher.BackendType | undefined {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
  return undefined
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {
  readonly subscribe: (
    directory: string,
    ignore?: string[],
  ) => Effect.Effect<Effect.Effect<void, never, never>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileWatcher") {}

const noop = Service.of({
  subscribe: () => Effect.succeed(Effect.void),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return noop

    const backend = getBackend()
    const location = yield* Location.Service
    if (!backend) {
      yield* Effect.logError("watcher backend not supported", {
        directory: location.directory,
        platform: process.platform,
      })
      return noop
    }

    const w = watcher()
    if (!w) return noop

    yield* Effect.logInfo("watcher backend", { directory: location.directory, platform: process.platform, backend })
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const subscriptions = new Map<
      string,
      { pending: Promise<ParcelWatcher.AsyncSubscription>; references: number }
    >()
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        Promise.allSettled(
          Array.from(subscriptions.values(), (active) =>
            active.pending.then((subscription) => subscription.unsubscribe()),
          ),
        ).then(() => subscriptions.clear()),
      ),
    )

    const callback: ParcelWatcher.SubscribeCallback = (_error, updates) => {
      for (const update of updates) {
        if (update.type === "create") runFork(events.publish(Event.Updated, { file: update.path, event: "add" }))
        if (update.type === "update") runFork(events.publish(Event.Updated, { file: update.path, event: "change" }))
        if (update.type === "delete") runFork(events.publish(Event.Updated, { file: update.path, event: "unlink" }))
      }
    }

    const unsubscribe = (
      directory: string,
      active: { pending: Promise<ParcelWatcher.AsyncSubscription>; references: number },
    ) => {
      let subscribed = true
      return Effect.suspend(() => {
        if (!subscribed) return Effect.void
        subscribed = false
        if (subscriptions.get(directory) !== active) return Effect.void
        active.references--
        if (active.references > 0) return Effect.void
        subscriptions.delete(directory)
        return Effect.promise(() =>
          active.pending.then((subscription) => subscription.unsubscribe()).catch(() => {}),
        )
      })
    }

    const acquire = (directory: string, ignore: string[]) =>
      Effect.suspend(() => {
        const active = subscriptions.get(directory)
        if (active) {
          active.references++
          return Effect.succeed(unsubscribe(directory, active))
        }

        const pending = w.subscribe(directory, callback, { ignore, backend })
        const created = { pending, references: 1 }
        subscriptions.set(directory, created)
        return Effect.promise(() => pending).pipe(
          Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
          Effect.as(unsubscribe(directory, created)),
          Effect.catchCause((cause) => {
            if (subscriptions.get(directory) === created) subscriptions.delete(directory)
            pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
            return Effect.logError("failed to subscribe", { directory, cause: Cause.pretty(cause) }).pipe(
              Effect.as(Effect.void),
            )
          }),
        )
      })

    const subscribe: Interface["subscribe"] = (directory, ignore = []) =>
      Effect.acquireRelease(acquire(directory, ignore), (cleanup) => cleanup)

    const config = (yield* (yield* Config.Service).entries())
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((item) => item.info.watcher?.ignore ?? [])
    if (location.vcs && (yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER)) {
      yield* Effect.forkScoped(
        subscribe(location.directory, [...Ignore.PATTERNS, ...config, ...protecteds(location.directory)]),
      )
    }

    if (location.vcs?.type === "git") {
      const resolved = (yield* git.repo.discover(location.directory))?.gitDirectory
      const vcs = resolved ? yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved))) : undefined
      if (vcs && !config.includes(".git") && !config.includes(vcs) && (!resolved || !config.includes(resolved))) {
        const ignore = (yield* fs.readDirectoryEntries(vcs).pipe(Effect.catch(() => Effect.succeed([])))).flatMap(
          (entry) => (entry.name === "HEAD" ? [] : [entry.name]),
        )
        yield* Effect.forkScoped(subscribe(vcs, ignore))
      }
    }

    return Service.of({ subscribe })
  }).pipe(
    Effect.catchCause((cause) => {
      return Effect.logError("failed to init watcher service", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(noop),
      )
    }),
  ),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Config.node, Git.node, EventV2.node],
})
