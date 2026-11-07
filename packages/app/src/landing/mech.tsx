import { onCleanup, onMount } from "solid-js"

const GLYPHS = "01ABCDEF0123456789<>/{}[]=+*#"
const CELL = 16

/** Columns of falling glyphs with a bright head, plus a scan line sweeping down. Static under reduced motion. */
export function Mech() {
  let canvas!: HTMLCanvasElement

  onMount(() => {
    const context = canvas.getContext("2d")
    if (!context) return
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches

    let width = 0
    let height = 0
    let frame = 0
    let last = 0
    let drops: number[] = []
    let speeds: number[] = []
    const style = getComputedStyle(canvas)
    const font = style.fontFamily
    const channels = (style.color.match(/\d+(\.\d+)?/g) ?? ["0", "98", "160"]).slice(0, 3).join(" ")

    const resize = () => {
      const ratio = devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width * ratio
      canvas.height = height * ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      const columns = Math.ceil(width / CELL)
      drops = Array.from({ length: columns }, () => Math.random() * -60)
      speeds = Array.from({ length: columns }, () => 0.25 + Math.random() * 0.6)
    }

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      if (now - last < 60) return
      last = now
      // Fade instead of clearing so each glyph leaves a trail.
      context.globalCompositeOperation = "destination-out"
      context.fillStyle = "rgb(0 0 0 / 0.16)"
      context.fillRect(0, 0, width, height)
      context.globalCompositeOperation = "source-over"
      context.font = `${CELL - 3}px ${font}`
      drops.forEach((row, column) => {
        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
        context.fillStyle = `rgb(${channels} / 0.4)`
        context.fillText(glyph, column * CELL, (row - 1) * CELL)
        context.fillStyle = `rgb(${channels} / 0.9)`
        context.fillText(glyph, column * CELL, row * CELL)
        drops[column] = row * CELL > height && Math.random() > 0.975 ? 0 : row + speeds[column]
      })
    }

    const paintStatic = () => {
      context.font = `${CELL - 3}px ${font}`
      context.fillStyle = `rgb(${channels} / 0.18)`
      for (let x = 0; x < width; x += CELL)
        for (let y = CELL; y < height; y += CELL * 3)
          if (Math.random() < 0.35) context.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], x, y)
    }

    const visibility = () => {
      cancelAnimationFrame(frame)
      if (!document.hidden && !still) frame = requestAnimationFrame(draw)
    }

    resize()
    addEventListener("resize", resize)
    document.addEventListener("visibilitychange", visibility)
    if (still) paintStatic()
    else frame = requestAnimationFrame(draw)
    onCleanup(() => {
      cancelAnimationFrame(frame)
      removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", visibility)
    })
  })

  return (
    <>
      <canvas ref={canvas} class="landing-rain" aria-hidden="true" />
      <div class="landing-grid" aria-hidden="true" />
      <div class="landing-scan" aria-hidden="true" />
    </>
  )
}
