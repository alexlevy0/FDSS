import fit from 'canvas-fit'
import css from 'dom-css'
import Alea from 'alea'
import { createSpring } from 'spring-animator'

const settings = {
  // text: 'Fievres \ndu \nSamedi Soir',
  text: `Fièvres du Samedi Soir`,
  particles: 900,
  dampening: 0.35, // 0.17
  stiffness: 0.85, // 0.9
  // speed: 150,
  // speed: 10,
  speed: 100,
  // speed: 150,
  // speed: 50,
  precision: 0.98,
  // precision: 0.8,
  lineOpacity: 0.5,
  autoEnterDelay: 3000, // ms before entering without a click
  exitFade: 2000, // ms for the title to fade out over the incoming scene
  exitTrail: 40, // frames the lines keep growing after entering, then freeze
  turnGranularity: 12,
  startSpreadMultiplier: 0.35,
  particleDieRate: 0,
  colorThreshold: 200,
  particleSize: 1
}

const container = document.querySelector('.title-card-container')
const canvas = container.querySelector('canvas')
const ctx = canvas.getContext('2d')
ctx.globalCompositeOperation = 'lighter'
const resize = fit(canvas)
window.addEventListener('resize', resize)

const instructions = container.querySelector('.instructions')
const button = container.querySelector('button')
let rand, points, pixelPicker, rAFToken, start, isFading
let exitFrames = 0

export default function createTitleCard () {
  return {
    resize: function () {
      if (isFading) return
      start = Date.now()
      resize()
      if (safeSetup()) loop()
    },
    show: function () {
      start = Date.now()
      setTimeout(() => {
        css(instructions, { opacity: 1 })
      }, 300)
      // a failed setup (zero-size viewport...) must not block entering:
      // the auto-enter timer below still resolves, and a resize retries
      if (safeSetup()) loop()
      return new Promise((resolve) => {
        let entered = false
        function enter () {
          if (entered) return
          entered = true
          clearTimeout(autoEnterToken)
          remove()
          activateDrawers()
          resolve()
        }
        // enter on click, or on its own after a few seconds
        const autoEnterToken = setTimeout(enter, settings.autoEnterDelay)
        button.addEventListener('click', (e) => {
          e.preventDefault()
          enter()
        }, { once: true })
      })
    }
  }

  // The scene is already fading in underneath (index.js `intro`), so this is
  // a crossfade: the particles scatter (activateDrawers) and the canvas fades
  // with an ease-in, staying visible while they fly and gone by the time the
  // grid is fully up. Pointer events are released right away so the scene
  // (camera controls) is usable during the fade.
  function remove () {
    isFading = true
    const fadeMs = settings.exitFade
    css(container, { pointerEvents: 'none' })
    css(instructions, {
      transition: 'opacity 400ms ease-out',
      opacity: 0
    })
    css(canvas, {
      transition: `opacity ${fadeMs}ms cubic-bezier(0.55, 0, 0.75, 0.6)`,
      opacity: 0
    })
    setTimeout(() => {
      window.removeEventListener('resize', resize)
      window.cancelAnimationFrame(rAFToken)
      if (container.parentElement) container.parentElement.removeChild(container)
    }, fadeMs + 200)
  }

  function loop () {
    if (!points) return
    if (!isFading && (Date.now() - start) > 30000) return
    // Once entered, the lines grow for a short flourish and then freeze:
    // the canvas keeps its last frame while its CSS opacity fades, so this
    // 2D loop stops competing with the first WebGL frames.
    if (isFading && exitFrames++ > settings.exitTrail) return
    window.cancelAnimationFrame(rAFToken)
    rAFToken = window.requestAnimationFrame(loop)
    update()
    draw()
  }

  function safeSetup () {
    try {
      setup()
      return true
    } catch (err) {
      console.warn('title card setup failed', err)
      points = null
      return false
    }
  }

  function setup () {
    console.log(`alexlevy0 🕴`)
    const seed = Math.random() * 1000 | 0 // 74 & 336 looks good
    rand = new Alea(seed)
    pixelPicker = getSource()
    points = (new Array(settings.particles)).fill().map(() => {
      const rads = rand() * Math.PI * 2
      const mag = Math.pow(rand(), 0.5) * settings.startSpreadMultiplier * Math.max(window.innerWidth, window.innerHeight)
      return {
        x: Math.cos(rads) * mag + ctx.canvas.width / 2,
        y: Math.sin(rads) * mag + ctx.canvas.height / 2,
        angle: createSpring(settings.dampening, settings.stiffness, rand() * Math.PI * 2),
        speed: rand() * settings.speed / 40,
        entropy: rand(),
        isActive: true,
        line: []
      }
    })
  }

  function update () {
    points.forEach((p) => {
      if (!p.isActive) return
      const averageVal = pixelPicker(p.x, p.y)
      const isOnActivePixel = p.line.length || averageVal < settings.colorThreshold

      if (isOnActivePixel) {
        p.line.push([p.x, p.y])
      }

      if (rand() < settings.precision) {
        updateNextAngle(p, pixelPicker)
      }

      const angle = p.angle.tick()
      const velX = Math.cos(angle) * p.speed
      const velY = Math.sin(angle) * p.speed
      p.x += velX
      p.y += velY

      if (rand() < settings.particleDieRate / 10) {
        p.isActive = false
      }
    })

    let i = 0
    while (i < points.length) {
      const p = points[i]
      if (!p.line.length && (p.x < 0 || p.y < 0 || p.x > ctx.canvas.width || p.y > ctx.canvas.height)) {
        points.splice(i, 1)
      } else {
        i += 1
      }
    }
  }

  function updateNextAngle (p, pixelPicker) {
    const angle = p.angle.tick(1, false)
    const currentPixelVal = pixelPicker(p.x, p.y)
    for (let i = 0; i <= settings.turnGranularity; i += 1) {
      const t = i / settings.turnGranularity * Math.PI
      let velX = Math.cos(angle + t) * p.speed
      let velY = Math.sin(angle + t) * p.speed
      let pixel = pixelPicker(p.x + velX, p.y + velY)
      if (pixel < currentPixelVal) {
        p.angle.updateValue(angle + t)
        break
      }
      velX = Math.cos(angle - t) * p.speed
      velY = Math.sin(angle - t) * p.speed
      pixel = pixelPicker(p.x + velX, p.y + velY)
      if (pixel < currentPixelVal) {
        p.angle.updateValue(angle - t)
        break
      }
    }
  }

  function activateDrawers () {
    if (!points) return
    settings.precision = 0.4
    points.forEach((p) => {
      p.isActive = true
      p.speed *= rand() * 10
      p.angle = createSpring(0.05, 0.9, p.angle.tick())
      p.angle.updateValue(rand() * Math.PI * 2)
    })
  }

  function draw () {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (settings.particleSize) {
      points.forEach((p) => {
        if (!p.isActive) return
        const radius = p.line.length ? settings.particleSize : 0
        const opacity = 0.2 * (radius < 10 ? radius / 10 : 1)
        ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
        ctx.stroke()
      })
    }

    ctx.beginPath()
    ctx.strokeStyle = `rgba(255, 255, 255, ${settings.lineOpacity})`
    for (let k = 0; k < points.length; k++) {
      const line = points[k].line
      if (line.length > 1) {
        ctx.moveTo(line[0][0], line[0][1])
        for (let j = 1; j < line.length; j++) ctx.lineTo(line[j][0], line[j][1])
      }
    }
    ctx.stroke()
  }
}

// ---------

function getSource () {
  const hiddenCanvas = container.appendChild(document.createElement('canvas'))
  const hiddenCtx = hiddenCanvas.getContext('2d')
  fit(hiddenCanvas)
  hiddenCanvas.style.display = 'none'
  if (!hiddenCanvas.width || !hiddenCanvas.height) {
    // zero-size viewport (collapsed pane, hidden iframe): getImageData would
    // throw. Return an all-white source (no text); a resize rebuilds it.
    hiddenCanvas.parentElement.removeChild(hiddenCanvas)
    return () => 255
  }
  hiddenCtx.fillStyle = 'rgb(255, 255, 255)'
  hiddenCtx.fillRect(0, 0, hiddenCanvas.width, hiddenCanvas.height)
  printText(hiddenCtx, settings.text, titleSize(hiddenCtx))
  const picker = makePixelPicker(hiddenCanvas)
  hiddenCanvas.parentElement.removeChild(hiddenCanvas)
  return picker
}

function makePixelPicker (canvas) {
  const imageData = canvas.getContext('2d').getImageData(
    0, 0, canvas.width, canvas.height
  )
  const data = imageData.data
  const width = imageData.width
  // average of r, g, b at (x, y), without allocating (called ~28 times per
  // particle per frame); NaN outside the image, as before
  return (x, y) => {
    const i = 4 * ((x | 0) + (y | 0) * width)
    return (data[i] + data[i + 1] + data[i + 2]) / 3
  }
}

// 7% of the short side, as before, but never wider than 88% of the canvas:
// with the viewport meta a portrait phone is ~390px wide, where the old size
// rule could push the long title past the edges.
function titleSize (context) {
  const { width, height } = context.canvas
  let size = Math.min(width, height) * 0.07
  context.font = `${size}px "Open Sans"`
  const textWidth = context.measureText(settings.text).width
  if (textWidth > width * 0.88 && textWidth > 0) size *= (width * 0.88) / textWidth
  return Math.max(1, size)
}

function printText (context, text, size) {
  context.font = `${size}px "Open Sans"`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = 'rgb(0, 0, 0)'
  context.fillText(text, context.canvas.width / 2, context.canvas.height / 3)
}
