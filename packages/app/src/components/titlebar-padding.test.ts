import { describe, expect, test } from "bun:test"
import { macTitlebarLeftPadding } from "./titlebar-padding"

describe("macOS titlebar padding", () => {
  test("reserves traffic light space while windowed", () => {
    expect(macTitlebarLeftPadding(1, false)).toBe("84px")
    expect(macTitlebarLeftPadding(2, false)).toBe("42px")
  })

  test("does not reserve traffic light space in fullscreen", () => {
    expect(macTitlebarLeftPadding(1, true)).toBe("0px")
  })
})
