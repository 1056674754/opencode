const macTrafficLightsWidth = 84

export function macTitlebarLeftPadding(zoom: number, fullscreen: boolean) {
  if (fullscreen) return "0px"
  return `${macTrafficLightsWidth / zoom}px`
}
