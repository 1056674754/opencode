import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionID } from "../../src/session/schema"

const originalEnv = new Map<string, string | undefined>()

const remember = (k: string) => {
  if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
}

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    remember(k)
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

const remove = (k: string) =>
  Effect.gen(function* () {
    remember(k)
    delete process.env[k]
    yield* Env.use.remove(k)
  })

// Reload against the live config; provider presence is driven by env keys that
// buildInitialSnapshot re-reads on every rebuild.
const reload = () =>
  Effect.gen(function* () {
    const cfg = yield* Config.use.get()
    yield* Provider.use.reloadProviders(cfg)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const providerLayer = LayerNode.compile(
  LayerNode.group([
    Provider.node,
    FSUtil.node,
    Env.node,
    Config.node,
    Auth.node,
    Plugin.node,
    ModelsDev.node,
    RuntimeFlags.node,
  ]),
)

const it = testEffect(providerLayer)

// Whitelist anthropic + openai so provider presence is fully controlled by env
// keys (no autoloaded free-model providers like opencode creeping in).
const enabled = { config: { enabled_providers: ["anthropic", "openai"] } }

const ANTHROPIC = ProviderV2.ID.anthropic
const OPENAI = ProviderV2.ID.openai
const CLAUDE = ModelV2.ID.make("claude-sonnet-4-6")

it.instance(
  "old session survives provider deletion",
  Effect.gen(function* () {
    // Given: ProviderSnapshot gen-1 with anthropic + openai, Session A pinned to it.
    yield* set("ANTHROPIC_API_KEY", "key-anthropic")
    yield* set("OPENAI_API_KEY", "key-openai")
    const gen1 = yield* Provider.use.list()
    expect(gen1[ANTHROPIC]).toBeDefined()
    expect(gen1[OPENAI]).toBeDefined()

    const sessionA = SessionID.make("ses-session-a")
    const pinned = yield* Provider.use.pinSession(sessionA)

    // When: reloadProviders rebuilds after anthropic's env key is removed (gen-2 keeps openai).
    yield* remove("ANTHROPIC_API_KEY")
    yield* reload()

    // Then: Session A still resolves claude via its pinned gen-1 snapshot.
    const claudeViaPin = yield* Provider.use.getModel(ANTHROPIC, CLAUDE, { snapshot: pinned })
    expect(claudeViaPin.id).toBe(CLAUDE)

    // And the current catalog no longer exposes anthropic.
    const current = yield* Provider.use.forSession()
    expect(current.providers[ANTHROPIC]).toBeUndefined()
    expect(current.providers[OPENAI]).toBeDefined()

    const currentExit = yield* Provider.use.getModel(ANTHROPIC, CLAUDE, { snapshot: current }).pipe(Effect.exit)
    expect(Exit.isFailure(currentExit)).toBe(true)
  }),
  enabled,
)

it.instance(
  "new session sees new catalog",
  Effect.gen(function* () {
    // Given: ProviderSnapshot gen-1 with only anthropic.
    yield* set("ANTHROPIC_API_KEY", "key-anthropic")
    const gen1 = yield* Provider.use.list()
    expect(gen1[ANTHROPIC]).toBeDefined()
    expect(gen1[OPENAI]).toBeUndefined()

    // When: reloadProviders runs after openai becomes available.
    yield* set("OPENAI_API_KEY", "key-openai")
    yield* reload()

    // Then: a brand-new (unpinned) session resolves to current and sees both.
    const forNew = yield* Provider.use.forSession(SessionID.make("ses-brand-new"))
    expect(forNew.providers[ANTHROPIC]).toBeDefined()
    expect(forNew.providers[OPENAI]).toBeDefined()
  }),
  enabled,
)

it.instance(
  "in-flight stream survives provider deletion",
  Effect.gen(function* () {
    // Given: a pinned gen-1 snapshot and a LanguageModelV3 resolved through it.
    // openai stays present so the post-deletion reload still validates and swaps.
    yield* set("ANTHROPIC_API_KEY", "key-anthropic")
    yield* set("OPENAI_API_KEY", "key-openai")
    const gen1 = yield* Provider.use.list()
    expect(gen1[ANTHROPIC]).toBeDefined()

    const sessionID = SessionID.make("ses-inflight")
    const pinned = yield* Provider.use.pinSession(sessionID)
    const model = yield* Provider.use.getModel(ANTHROPIC, CLAUDE, { snapshot: pinned })
    const languageFirst = yield* Provider.use.getLanguage(model, { snapshot: pinned })

    // When: anthropic is deleted by reloading after its env key is removed.
    yield* remove("ANTHROPIC_API_KEY")
    yield* reload()
    const afterReload = yield* Provider.use.forSession()
    expect(afterReload.providers[ANTHROPIC]).toBeUndefined()

    // Then: re-resolving against the still-pinned gen-1 snapshot returns the
    // identical LanguageModelV3 reference, so an in-flight stream that captured
    // it never re-resolves against the new (emptier) catalog.
    const languageAgain = yield* Provider.use.getLanguage(model, { snapshot: pinned })
    expect(languageAgain).toBe(languageFirst)
  }),
  enabled,
)

it.instance(
  "failed reload leaves current unchanged",
  Effect.gen(function* () {
    // Given: a valid ProviderSnapshot gen-1 with anthropic.
    yield* set("ANTHROPIC_API_KEY", "key-anthropic")
    const gen1 = yield* Provider.use.forSession()
    expect(gen1.providers[ANTHROPIC]).toBeDefined()

    // When: reloadProviders runs against an env that yields no providers.
    // Swallow the outcome (fail or no-op) — the invariant under test is that a
    // broken catalog never replaces a valid live snapshot.
    yield* remove("ANTHROPIC_API_KEY")
    const cfg = yield* Config.use.get()
    yield* Provider.use.reloadProviders(cfg).pipe(Effect.exit)

    // Then: the current snapshot is the exact same object, still valid.
    const current = yield* Provider.use.forSession()
    expect(current).toBe(gen1)
    expect(current.providers[ANTHROPIC]).toBeDefined()
  }),
  enabled,
)
