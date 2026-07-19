import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderError } from "@/provider/error"
import { LLMAISDK } from "@/session/llm/ai-sdk"

type AdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]

function unknownFinishStep(inputTokens?: number) {
  return {
    type: "finish-step",
    response: { id: "response-empty", timestamp: new Date(0), modelId: "gpt-test" },
    finishReason: "other",
    rawFinishReason: "other",
    usage: {
      inputTokens,
      outputTokens: undefined,
      totalTokens: inputTokens,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
      inputTokenDetails: { noCacheTokens: inputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    },
    providerMetadata: undefined,
  } satisfies AdapterEvent
}

test("returns a retryable stream error when an empty step finishes with an unknown reason", async () => {
  // Given an AI SDK step that received headers but no model output or usage.
  const event = unknownFinishStep()

  // When the adapter translates the terminal step.
  const error = await Effect.runPromise(Effect.flip(LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), event)))

  // Then the session retry policy receives a typed retryable transport failure.
  expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
  if (!(error instanceof ProviderError.ResponseStreamError)) throw new Error("expected response stream error")
  expect(error.message).toBe("Provider stream ended without producing output")
})

test("preserves an unknown finish after an explicit abort", async () => {
  // Given an adapter stream explicitly aborted by its caller.
  const state = LLMAISDK.adapterState()
  await Effect.runPromise(LLMAISDK.toLLMEvents(state, { type: "abort" }))

  // When the SDK subsequently emits its synthetic unknown finish.
  const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, unknownFinishStep()))

  // Then it remains a terminal abort instead of being restarted.
  expect(events).toMatchObject([{ type: "step-finish", reason: "unknown" }])
})

test("preserves an unknown finish after tool activity", async () => {
  // Given a stream that already began constructing a tool call.
  const state = LLMAISDK.adapterState()
  await Effect.runPromise(
    LLMAISDK.toLLMEvents(state, {
      type: "tool-input-start",
      id: "call-1",
      toolName: "bash",
      providerMetadata: undefined,
    }),
  )

  // When the provider ends with an unknown finish and empty usage.
  const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, unknownFinishStep()))

  // Then OpenCode does not replay the turn and risk duplicate tool effects.
  expect(events).toMatchObject([{ type: "step-finish", reason: "unknown" }])
})

test("preserves an unknown finish after text or reasoning activity", async () => {
  // Given streams that already emitted a text or reasoning block.
  const inputs: AdapterEvent[] = [
    { type: "text-start", id: "text-1", providerMetadata: undefined },
    { type: "reasoning-start", id: "reasoning-1", providerMetadata: undefined },
  ]

  // When each stream subsequently finishes unknown with empty usage.
  for (const input of inputs) {
    const state = LLMAISDK.adapterState()
    await Effect.runPromise(LLMAISDK.toLLMEvents(state, input))
    const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, unknownFinishStep()))

    // Then neither stream is retried after exposing model output.
    expect(events).toMatchObject([{ type: "step-finish", reason: "unknown" }])
  }
})

test("preserves an unknown finish after a tool result", async () => {
  // Given a stream that already returned a provider-executed tool result.
  const state = LLMAISDK.adapterState()
  await Effect.runPromise(
    LLMAISDK.toLLMEvents(state, {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "lookup",
      input: { query: "weather" },
      output: { title: "Lookup", output: "sunny", metadata: {} },
      providerExecuted: true,
      providerMetadata: undefined,
    }),
  )

  // When the provider then reports an unknown finish with empty usage.
  const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, unknownFinishStep()))

  // Then the completed tool result is not put at risk of replay.
  expect(events).toMatchObject([{ type: "step-finish", reason: "unknown" }])
})

test("preserves an unknown finish when the provider reports token usage", async () => {
  // Given a provider finish carrying non-zero accounting.
  const state = LLMAISDK.adapterState()

  // When it reports an unknown finish without visible output.
  const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, unknownFinishStep(1)))

  // Then OpenCode preserves it because the turn was not truly empty.
  expect(events).toMatchObject([{ type: "step-finish", reason: "unknown", usage: { inputTokens: 1 } }])
})
