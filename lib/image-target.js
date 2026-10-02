/**
 * 请求图像投影几何。
 *
 * DSH 的 `ctx.attachments.readImageRequest()` 要的是**路由选定的绝对宽高**
 * （`ImageRequestTarget = { width, height, maxBytes }`），不是像素预算。少传
 * width/height 时 `dsh-attachment-local` 的 `validateTarget` 会以
 * `INVALID_ATTACHMENT_REF`（"Image request width must be a positive integer."）
 * 拒绝，适配器随即把该图降级成占位文字 —— 模型只看到
 * `[image omitted: attachment sha256:… could not be read]`，看不出真实原因。
 *
 * 这里的两个几何函数是 `@deepseek-ai/dsh-attachment` 同名导出的**逐行复刻**。
 * 复刻而不 import 是为了守住本插件「附件服务按结构契约处理、不新增 peer
 * 依赖」的设计：静态 import 会把整个包变成硬依赖，一旦解析失败插件根本加载
 * 不了，比图片降级严重得多。等价性由 `scripts/smoke-image-target.mjs` 在多种
 * 尺寸上对官方实现逐点比对。
 *
 * @module image-target
 */
/** 请求图像投影预算（与 dsh 内置 provider 同量级：0.64 MP / 1 MiB）。 */
export const DEFAULT_REQUEST_IMAGE_PIXELS = 640_000;
export const DEFAULT_REQUEST_IMAGE_BYTES = 1024 * 1024;
/** 请求图像长边硬上限，与内置 provider 的 `REQUEST_IMAGE_MAX_DIMENSION` 对齐。 */
export const REQUEST_IMAGE_MAX_EDGE = 4096;
/**
 * 官方 `requestImageDimensions` 的复刻：在总像素预算内等比缩小到整数尺寸，
 * 小图不放大。内缩到预算之内，必要时逐像素回退长边。
 *
 * @param width - 源宽（正整数）。
 * @param height - 源高（正整数）。
 * @param maxPixels - 宽×高的硬上限（正整数）。
 */
export function requestImageDimensions(width, height, maxPixels) {
    const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
    if (scale === 1)
        return { width, height };
    if (width >= height) {
        let projectedWidth = Math.max(1, Math.floor(width * scale));
        let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
        while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
            projectedWidth -= 1;
            projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
        }
        return { width: projectedWidth, height: projectedHeight };
    }
    let projectedHeight = Math.max(1, Math.floor(height * scale));
    let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
    while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
        projectedHeight -= 1;
        projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
    }
    return { width: projectedWidth, height: projectedHeight };
}
/**
 * 官方 `longEdgeDimensions` 的复刻：精确按长边缩放，短边四舍五入；
 * 目标长边不小于源长边时原样返回。
 *
 * @param width - 源宽（正整数）。
 * @param height - 源高（正整数）。
 * @param longEdge - 长边目标（正整数）。
 */
export function longEdgeDimensions(width, height, longEdge) {
    if (longEdge >= Math.max(width, height))
        return { width, height };
    return width >= height
        ? { width: longEdge, height: Math.max(1, Math.round(longEdge * height / width)) }
        : { width: Math.max(1, Math.round(longEdge * width / height)), height: longEdge };
}
/**
 * 由源尺寸算出路由选定的请求图像目标。
 *
 * 先按像素预算等比缩，再对长边兜一道硬上限：像素预算管不住极端长宽比
 * （例如 20000×10 的图总像素本来就低于预算，但长边远超上限）。
 *
 * @param width - 源宽（正整数）。
 * @param height - 源高（正整数）。
 * @returns 可直接交给 `readImageRequest` 的目标。
 */
export function resolveRequestImageTarget(width, height) {
    const budgeted = requestImageDimensions(width, height, DEFAULT_REQUEST_IMAGE_PIXELS);
    const projected = Math.max(budgeted.width, budgeted.height) > REQUEST_IMAGE_MAX_EDGE
        ? longEdgeDimensions(width, height, REQUEST_IMAGE_MAX_EDGE)
        : budgeted;
    return { width: projected.width, height: projected.height, maxBytes: DEFAULT_REQUEST_IMAGE_BYTES };
}
