import { IMAGE_MAX_HEIGHT, IMAGE_MAX_WIDTH } from '../../platform/page'

// Same recipe as Even Realities' own official image template
// (evenhub-templates/image/src/image/renderer.ts): draw on an offscreen
// canvas, export PNG bytes, let the host's updateImageRawData decode and
// convert to 4-bit greyscale. No manual dithering or greyscale conversion
// here on purpose - docs/platform.md's Image containers section (sourced
// from that same template) says the host does a better job of it than a
// naive client-side pass would.
export async function drawTestPattern(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_MAX_WIDTH
  canvas.height = IMAGE_MAX_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')

  const gradient = ctx.createLinearGradient(0, 0, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
  gradient.addColorStop(0, '#000000')
  gradient.addColorStop(0.5, '#888888')
  gradient.addColorStop(1, '#ffffff')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)

  // A few flat shapes alongside the gradient: this is also the first real
  // test of "solid shape with a hard edge", the case the design guidelines'
  // icon workflow actually cares about, not just a smooth photographic ramp.
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(IMAGE_MAX_WIDTH * 0.25, IMAGE_MAX_HEIGHT * 0.5, 30, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#000000'
  ctx.fillRect(IMAGE_MAX_WIDTH * 0.6, IMAGE_MAX_HEIGHT * 0.25, 60, 60)

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 20px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('LAB', IMAGE_MAX_WIDTH / 2, IMAGE_MAX_HEIGHT - 20)

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

// All-black: on this display black is off, so this is the "does sending an
// image ever let us get BACK to blank" probe - page.ts's own history records
// that a docs-cited claim of exactly this ("black pixels are off, so an
// all-black image effectively clears a container") has never been verified
// by us and is marked [UNVERIFIED by us] in docs/platform.md.
export async function drawAllBlack(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_MAX_WIDTH
  canvas.height = IMAGE_MAX_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}
