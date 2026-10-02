/**
 * 请求图像目标（ImageRequestTarget）的本地单元测试，直接跑编译产物
 * `lib/image-target.js`，无网络依赖。
 *
 * 这里钉的是「图片变成 [image omitted: attachment sha256:… could not be read]」
 * 那个 bug 的根因：DSH 的 `ctx.attachments.readImageRequest()` 收的是
 * **绝对宽高**（`{ width, height, maxBytes }`），不是旧版的像素预算
 * （`{ maxPixels, maxBytes }`）。少传 width/height 时
 * `dsh-attachment-local` 的 validateTarget 以 INVALID_ATTACHMENT_REF 拒绝，
 * 适配器随即把图降级成占位文字。
 *
 * 覆盖：
 *
 * [A] 几何复刻等价性 —— `lib/image-target.js` 的两个纯函数必须与
 *     `@deepseek-ai/dsh-attachment` 的同名导出在全部抽样尺寸上逐点相等；
 * [B] 目标形状契约 —— `resolveRequestImageTarget()` 的输出必须是正整数，
 *     即 validateTarget 实际校验的三条不变式；
 * [C] 长边兜底 —— 像素预算管不住极端长宽比（20000×10 总像素低于预算），
 *     长边必须被硬上限截住。
 *
 * 用法：node scripts/smoke-image-target.mjs
 */

import {
  DEFAULT_REQUEST_IMAGE_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXELS,
  REQUEST_IMAGE_MAX_EDGE,
  longEdgeDimensions,
  requestImageDimensions,
  resolveRequestImageTarget,
} from '../lib/image-target.js'
import {
  longEdgeDimensions as officialLongEdge,
  requestImageDimensions as officialRequest,
} from '@deepseek-ai/dsh-attachment'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

// ---------------------------------------------------------------- [A] 等价性

// 覆盖：正方 / 横 / 竖 / 极小 / 极大 / 极端长宽比 / 质数边 / 恰好卡在预算上的边界
const SAMPLES = [
  [1, 1], [2, 2], [10, 10], [16, 16], [100, 100],
  [1024, 1024], [1254, 1254], [1500, 1500], [4096, 4096], [8192, 8192],
  [1600, 900], [1920, 1080], [4032, 3024], [8000, 600],
  [900, 1600], [1080, 1920], [3024, 4032], [600, 8000],
  [20000, 10], [10, 20000], [65535, 3], [3, 65535],
  [797, 1319], [1319, 797], [640000, 1], [1, 640000],
]
const BUDGETS = [DEFAULT_REQUEST_IMAGE_PIXELS, 1, 2, 1024, 100_000, 1_000_000, 64_000_000]

let geometryMismatch = undefined
let geometryPairs = 0
for (const [w, h] of SAMPLES) {
  for (const budget of BUDGETS) {
    geometryPairs += 1
    const mine = requestImageDimensions(w, h, budget)
    const theirs = officialRequest(w, h, budget)
    if (mine.width !== theirs.width || mine.height !== theirs.height) {
      geometryMismatch ??= `${w}x${h}@${budget}: mine=${mine.width}x${mine.height} official=${theirs.width}x${theirs.height}`
    }
    // 复刻函数本身也必须守住「不放大、不越预算」两条语义
    if (mine.width > w || mine.height > h) geometryMismatch ??= `${w}x${h}@${budget}: 被放大了`
    if (mine.width * mine.height > budget) geometryMismatch ??= `${w}x${h}@${budget}: 超出像素预算`
  }
}
check(`requestImageDimensions 与官方逐点一致（${geometryPairs} 组）`, geometryMismatch === undefined, geometryMismatch)

let edgeMismatch = undefined
for (const [w, h] of SAMPLES) {
  for (const edge of [1, 2, 64, 1024, 4096, 8192, 100000]) {
    const mine = longEdgeDimensions(w, h, edge)
    const theirs = officialLongEdge(w, h, edge)
    if (mine.width !== theirs.width || mine.height !== theirs.height) {
      edgeMismatch ??= `${w}x${h}@${edge}: mine=${mine.width}x${mine.height} official=${theirs.width}x${theirs.height}`
    }
  }
}
check('longEdgeDimensions 与官方逐点一致', edgeMismatch === undefined, edgeMismatch)

// ------------------------------------------------------------ [B] 形状契约

const isPositiveSafeInteger = v => Number.isSafeInteger(v) && v > 0
let shapeFailure = undefined
for (const [w, h] of SAMPLES) {
  const target = resolveRequestImageTarget(w, h)
  if (!isPositiveSafeInteger(target.width)) { shapeFailure ??= `${w}x${h}: width=${target.width}`; break }
  if (!isPositiveSafeInteger(target.height)) { shapeFailure ??= `${w}x${h}: height=${target.height}`; break }
  if (!isPositiveSafeInteger(target.maxBytes)) { shapeFailure ??= `${w}x${h}: maxBytes=${target.maxBytes}`; break }
  // 不得出现旧版的 maxPixels 键：那正是被附件服务拒绝的形状
  if ('maxPixels' in target) { shapeFailure ??= `${w}x${h}: 仍带 maxPixels 键`; break }
}
check('resolveRequestImageTarget 输出正整数宽高（validateTarget 的三条不变式）', shapeFailure === undefined, shapeFailure)

const square = resolveRequestImageTarget(1024, 1024)
check('1024×1024 @0.64MP → 800×800', square.width === 800 && square.height === 800, `${square.width}x${square.height}`)
check('maxBytes 取自请求预算', square.maxBytes === DEFAULT_REQUEST_IMAGE_BYTES, String(square.maxBytes))

const small = resolveRequestImageTarget(320, 240)
check('小图不放大', small.width === 320 && small.height === 240, `${small.width}x${small.height}`)

// ------------------------------------------------------------- [C] 长边兜底

const wide = resolveRequestImageTarget(20000, 10)
const widePixels = wide.width * wide.height
check('极端横图长边被截到上限', wide.width === REQUEST_IMAGE_MAX_EDGE, `${wide.width}x${wide.height}`)
check('极端横图总像素仍在预算内', widePixels <= DEFAULT_REQUEST_IMAGE_PIXELS, String(widePixels))

const tall = resolveRequestImageTarget(10, 20000)
check('极端竖图长边被截到上限', tall.height === REQUEST_IMAGE_MAX_EDGE, `${tall.width}x${tall.height}`)

// ------------------------------------------------------------------ 结论

if (failures.length > 0) {
  console.error('\n图像目标测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n图像目标测试全部通过。')
