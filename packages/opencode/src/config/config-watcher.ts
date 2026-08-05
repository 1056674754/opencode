export * as ConfigWatcher from "./config-watcher"

import fs from "node:fs"
import { Global } from "@opencode-ai/core/global"
import { Effect, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Provider } from "@/provider/provider"
import { Config } from "./config"
import { ConfigPaths } from "./paths"

export const watchConfigFiles = Effect.fn("ConfigWatcher.watchConfigFiles")(function* (directory?: string) {
  const config = yield* Config.Service
  const provider = yield* Provider.Service
  const bridge = yield* EffectBridge.make()
  const parentScope = yield* Scope.Scope
  const scope = yield* Scope.fork(parentScope)
  const paths = Array.from(
    new Set([
      ...(yield* ConfigPaths.files("opencode", directory ?? Global.Path.config).pipe(Effect.orDie)),
      ...ConfigPaths.fileInDirectory(Global.Path.config, "opencode"),
    ]),
  ).filter(fs.existsSync)

  let timeout: ReturnType<typeof setTimeout> | undefined
  let reloading = false
  let dirty = false

  const doReload = Effect.gen(function* () {
    const freshCfg = yield* config.getFresh()
    yield* provider.reloadProviders(freshCfg)
    yield* config.commitFresh()
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("config watcher reload failed", { cause })))

  const runReload = Effect.gen(function* () {
    if (reloading) {
      dirty = true
      return
    }
    reloading = true
    dirty = false
    yield* doReload
    while (dirty) {
      dirty = false
      yield* doReload
    }
    reloading = false
  })

  const onChange = () => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      timeout = undefined
      void bridge.fork(runReload)
    }, 500)
  }

  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      if (timeout) clearTimeout(timeout)
    }),
  )
  yield* Effect.forEach(
    paths,
    (file) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const watcher = fs.watch(file, onChange)
          watcher.on("error", (err) => {
            Effect.runFork(
              Effect.logError("config watcher error", { file, error: String(err) }),
            )
          })
          return watcher
        }),
        (watcher) => Effect.sync(() => watcher.close()),
      ).pipe(Scope.provide(scope)),
    { discard: true },
  )
  yield* Effect.logInfo("config watcher started", { paths })
  return scope
})
