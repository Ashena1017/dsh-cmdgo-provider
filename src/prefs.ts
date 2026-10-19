/**
 * 用户偏好：模型可见性 + 会话头部 HUD 开关 + 配色方案。
 *
 * 与 `pool.ts` / `meter.ts` 同构：状态落在 `~/.dsh/cmdgo-prefs.json`，
 * 使用 `homedir()` 而不是 `DSH_HOME`（与那两个文件保持一致，便于一起备份）。
 *
 * 模型可见性是**黑名单制**：只有被显式关闭的模型才出现在 `hidden` 里，
 * 不在表里即为可见。这样上游新增模型会自动出现，用户不用手工放行；
 * 反复开关也不会让文件无限膨胀（打开 = 删键，而不是写 `false`）。
 *
 * @module cmdgo/prefs
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** 落盘格式。`version` 用来自我识别，将来改结构时可以按版本迁移。 */
export interface CmdgoPrefsFile {
  version: 1
  /** 黑名单：被关闭的模型 id。 */
  hiddenModels: string[]
  /** 会话头部额度胶囊是否显示。 */
  hudEnabled: boolean
  /** 设置页配色方案。缺省（老文件没有这个键）= `system`。 */
  theme?: CmdgoThemePreference
  /** 额度胶囊的位置。缺省（老文件没有这个键）= `header`（插件原有位置）。 */
  hudPosition?: CmdgoHudPosition
  /** 胶囊自定义文字模板。缺省（老文件没有这个键 / 空串）= 内置默认排版。 */
  hudTemplate?: string
}

/** 胶囊模板的长度上限：足够写一整行，又不至于把偏好文件撑爆。 */
export const MAX_HUD_TEMPLATE_LENGTH = 300

/**
 * 把跨越边界的模板值收敛成可落盘的字符串。
 *
 * 只做两件事：非字符串→空串（= 用默认排版）、截断到上限。
 * **不去首尾空白、不折叠连续空格** —— 模板里的空格是有意义的（用户拿它对齐或
 * 做分隔），渲染层用 `white-space:pre` 原样呈现；这里若顺手 trim 一下，设置页
 * 预览（渲染原始文本）和胶囊就会差几个空格。
 * **不校验语法** —— 模板语法错误由 `hud-template.ts` 在渲染时回报给设置页
 * （那里要给用户看错误在哪），而不是在写盘这一层静默改写用户的输入。
 * @param value - HTTP body 或存档里的原始值。
 * @returns 可落盘的模板字符串；空串表示用默认排版。
 */
export function normalizeHudTemplate(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, MAX_HUD_TEMPLATE_LENGTH)
}

/**
 * 额度胶囊的位置。
 *
 * - `header`：会话头部右上角工具区 —— 插件一直以来的位置，也是默认值。
 * - `composer`：composer 工具行、模型选择器左侧 —— 0.9.4 里搬过去的，
 *   和「当前用哪个模型」挨着读得顺，但它改变了既有用户习惯，所以做成可选项
 *   而不是直接改默认值。
 *
 * ⚠️ `composer` 槽（`conversation.input.right`）只在选中本插件模型时才该占位，
 * 否则别人的会话里也会多出一颗与当前模型无关的胶囊 —— 那需要「模型门禁」，
 * 而门禁曾在两个 Hook 之间提前 return，让 Hook 数量随 provider 变化并直接
 * 抛错（见 lib/client.js 里 QuotaHudPill 的注释）。这里的实现把门禁所需
 * 状态放在 hook 之后做纯计算，不再有条件 return 穿插。
 */
export type CmdgoHudPosition = 'header' | 'composer'

/** 可接受的胶囊位置（顺序即 UI 里两个按钮的顺序）。 */
export const CMDGO_HUD_POSITIONS: readonly CmdgoHudPosition[] = ['header', 'composer']

/** 无存档时的位置：会话右上角（插件原有行为，不改变老用户观感）。 */
export const DEFAULT_CMDGO_HUD_POSITION: CmdgoHudPosition = 'header'

/**
 * 把一个跨越边界的值收敛成可落盘的胶囊位置。
 * @param value - HTTP body 或存档里的原始值。
 * @returns 合法的位置；无法识别时返回默认值。
 */
export function isCmdgoHudPosition(value: unknown): value is CmdgoHudPosition {
  return typeof value === 'string' && (CMDGO_HUD_POSITIONS as readonly string[]).includes(value)
}

/**
 * 设置页的配色方案。
 *
 * 与宿主的 `ui-theme` 偏好**同名同义**（`light` / `dark` / `system`），
 * 但它是本插件自己的存档：插件分区在设置页里是独立的一块视觉，
 * 用户可能想让 harness 保持深色、而这块面板用浅色（或反过来）。
 * 默认 `system` —— 与宿主默认值一致，装上即"跟随系统"。
 */
export type CmdgoThemePreference = 'light' | 'dark' | 'system'

/** 可接受的配色方案（顺序即 UI 里三个按钮的顺序）。 */
export const CMDGO_THEME_PREFERENCES: readonly CmdgoThemePreference[] = ['light', 'dark', 'system']

/** 无存档时的配色方案：跟随系统（与宿主 `DEFAULT_PREFERENCE` 对齐）。 */
export const DEFAULT_CMDGO_THEME: CmdgoThemePreference = 'system'

/**
 * 把一个跨越边界的值收敛成可落盘的配色方案。
 *
 * 边界上的值来自 HTTP body 或磁盘上的旧文件，两者都可能是任意值；
 * 认不出来就退回默认的 `system`，绝不把脏值写进存档。
 * @param value - HTTP body 或存档里的原始值。
 * @returns 合法的配色方案；无法识别时返回默认值。
 */
export function isCmdgoThemePreference(value: unknown): value is CmdgoThemePreference {
  return typeof value === 'string' && (CMDGO_THEME_PREFERENCES as readonly string[]).includes(value)
}

/** 保守解析：任何意外形状都退回默认值，绝不让坏文件拖垮启动。 */
function parsePrefs(raw: string): {
  hiddenModels: string[]
  hudEnabled: boolean
  theme: CmdgoThemePreference
  hudPosition: CmdgoHudPosition
  hudTemplate: string
} {
  const parsed: unknown = JSON.parse(raw)
  const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : {}
  const hiddenModels = Array.isArray(record.hiddenModels)
    ? record.hiddenModels.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  return {
    hiddenModels,
    // 缺省为显示：只有显式写 false 才隐藏（老文件没有这个键 → 保持可见）。
    hudEnabled: record.hudEnabled !== false,
    // 缺省为跟随系统：老文件没有这个键 → 与宿主默认值一致。
    theme: isCmdgoThemePreference(record.theme) ? record.theme : DEFAULT_CMDGO_THEME,
    // 缺省为会话右上角：老文件没有这个键 → 保持插件原有位置。
    hudPosition: isCmdgoHudPosition(record.hudPosition) ? record.hudPosition : DEFAULT_CMDGO_HUD_POSITION,
    // 缺省为空串 = 用内置默认排版（老文件没有这个键 → 外观不变）。
    hudTemplate: normalizeHudTemplate(record.hudTemplate),
  }
}

/**
 * 模型可见性与 HUD 开关的内存权威副本 + 落盘。
 *
 * 读取走 `ensureLoaded()`，写入立即更新内存再异步落盘（失败只记日志，
 * 不回滚内存 —— 与账号池同样的取舍：用户的这次点击本轮就该生效）。
 */
export class CmdgoPrefs {
  private hidden = new Set<string>()
  private hud = true
  private themeMode: CmdgoThemePreference = DEFAULT_CMDGO_THEME
  private hudPos: CmdgoHudPosition = DEFAULT_CMDGO_HUD_POSITION
  private hudTpl = ''
  private loaded = false
  /** 进行中的加载；并发调用共享同一个 promise，避免读到半载文件。 */
  private loading: Promise<void> | undefined
  /**
   * 落盘串行链。
   *
   * `persist()` 会在第一次 `await` 之前把 payload 固化下来，而每次写又是
   * 「写临时文件 + rename」两步。两次并发保存（比如批量开关模型时连点两行、
   * 或前一次 rename 卡在慢盘上）各自 rename，**后完成的那个赢** —— 落盘的
   * 可能反而是较早那次的状态，重启后用户先做的操作显示出来、后做的丢了。
   *
   * 所以不能各写各的：把整段「生成 payload + 写入 + rename」挂到这条链尾，
   * 保证调用顺序 = 落盘顺序，最后一次调用最后落盘。
   *
   * 链上单个任务失败**不能**污染后续：每次 `.then` 前先 catch 成 resolved，
   * 否则一次写失败会让后面所有保存都短路（用户会看到「怎么点都没反应」）。
   */
  private writing: Promise<void> = Promise.resolve()

  constructor(
    /** 落盘路径；缺省 `~/.dsh/cmdgo-prefs.json`。 */
    private readonly file: string = join(homedir(), '.dsh', 'cmdgo-prefs.json'),
    private readonly log: (message: string) => void = () => {},
  ) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const parsed = parsePrefs(await readFile(this.file, 'utf8'))
        this.hidden = new Set(parsed.hiddenModels)
        this.hud = parsed.hudEnabled
        this.themeMode = parsed.theme
        this.hudPos = parsed.hudPosition
        this.hudTpl = parsed.hudTemplate
      } catch (_missingOrCorrupt) {
        // 文件不存在或损坏：用默认值（全部可见 + HUD 开 + 跟随系统 + 右上角 + 默认模板）。
        this.hidden = new Set()
        this.hud = true
        this.themeMode = DEFAULT_CMDGO_THEME
        this.hudPos = DEFAULT_CMDGO_HUD_POSITION
        this.hudTpl = ''
      }
      this.loaded = true
      this.loading = undefined
    })()
    return this.loading
  }

  /**
   * 排队落盘：返回的 promise 在**本次写入真正落盘后**才 resolve。
   *
   * 调用方 `await persist()` 拿到的是自己那次写入完成，而不是链上随便哪次 ——
   * `setModelHidden` 等接口靠这一点保证「await 返回时磁盘已是最新」。
   */
  private persist(): Promise<void> {
    // 失败不传染：上一个任务抛错也让下一个照常跑。
    this.writing = this.writing.then(
      () => this.writeNow(),
      () => this.writeNow(),
    )
    return this.writing
  }

  /**
   * 真正的写盘动作。**只由 persist() 串行调用**，不要直接调。
   *
   * payload 在这里（而不是在 persist 里）生成：入队时就该定型还是落盘时才取，
   * 看起来等价，但后者才是正确的 —— 若在入队时固化，两次几乎同时的调用会
   * 生成两份内容相同或相近的 payload，最后一次未必包含最全的状态。放到真正
   * 写之前取，配合串行链，落盘的永远是「轮到它时」的完整内存状态。
   */
  private async writeNow(): Promise<void> {
    const payload: CmdgoPrefsFile = {
      version: 1,
      hiddenModels: [...this.hidden].sort(),
      hudEnabled: this.hud,
      theme: this.themeMode,
      hudPosition: this.hudPos,
      hudTemplate: this.hudTpl,
    }
    const text = JSON.stringify(payload, null, 2)
    try {
      await mkdir(dirname(this.file), { recursive: true })
      // 先写临时文件再 rename：读到半个文件比读不到更糟（会丢掉整份偏好）。
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, this.file)
    } catch (error) {
      this.log(`[cmdgo] 偏好写入失败（不影响本次会话）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 同步视图：已加载后可直接读，供每次 `listModels()` 使用。 */
  get hiddenIds(): ReadonlySet<string> {
    return this.hidden
  }

  get hudEnabled(): boolean {
    return this.hud
  }

  /** 当前配色方案偏好（`light` / `dark` / `system`）。 */
  get themePreference(): CmdgoThemePreference {
    return this.themeMode
  }

  /** 当前额度胶囊位置（`header` / `composer`）。 */
  get hudPosition(): CmdgoHudPosition {
    return this.hudPos
  }

  /** 某个模型当前是否可见。 */
  isVisible(modelId: string): boolean {
    return !this.hidden.has(modelId)
  }

  /** 关闭（true）或打开（false）一个模型；语义与 codearts 的黑名单一致。 */
  async setModelHidden(modelId: string, hidden: boolean): Promise<void> {
    await this.ensureLoaded()
    const changed = hidden ? !this.hidden.has(modelId) : this.hidden.has(modelId)
    if (!changed) return
    if (hidden) this.hidden.add(modelId)
    else this.hidden.delete(modelId)
    await this.persist()
  }

  /**
   * 批量关闭（「全关」）。只对当前目录**确实存在**的 id 生效，
   * 且与已有条目合并 —— 单独关过的模型不会因为一次「全关」而丢失。
   */
  async hideMany(modelIds: readonly string[]): Promise<void> {
    await this.ensureLoaded()
    if (modelIds.length === 0) return
    let changed = false
    for (const id of modelIds) {
      if (this.hidden.has(id)) continue
      this.hidden.add(id)
      changed = true
    }
    if (changed) await this.persist()
  }

  /**
   * 清空整个黑名单（「全开」）。
   *
   * ⚠️ 刻意**不看当前目录**：直接清空所有键 —— 与 codearts 的 `clearDisabledModels`
   * 同一取舍。「曾被关闭、后来从服务端目录下线」的遗留键按目录清是永远清不掉的。
   */
  async clearHidden(): Promise<void> {
    await this.ensureLoaded()
    if (this.hidden.size === 0) return
    this.hidden = new Set()
    await this.persist()
  }

  /** HUD 胶囊显示开关。 */
  async setHudEnabled(enabled: boolean): Promise<void> {
    await this.ensureLoaded()
    if (this.hud === enabled) return
    this.hud = enabled
    await this.persist()
  }

  /**
   * 设置配色方案。
   *
   * 这里**不做取值校验**：`themeMode` 的类型已经把它收窄到位，而真正跨越
   * 边界的是 HTTP body —— 那一层由 `isCmdgoThemePreference()` 收敛（见 index.ts
   * 的 `/theme/set`）。校验放在边界上，这里保持"写一个已知合法的值"。
   */
  async setThemePreference(preference: CmdgoThemePreference): Promise<void> {
    await this.ensureLoaded()
    if (this.themeMode === preference) return
    this.themeMode = preference
    await this.persist()
  }

  /**
   * 设置胶囊位置。校验同样在 HTTP 边界（`isCmdgoHudPosition()`），这里只写合法值。
   */
  async setHudPosition(position: CmdgoHudPosition): Promise<void> {
    await this.ensureLoaded()
    if (this.hudPos === position) return
    this.hudPos = position
    await this.persist()
  }

  /**
   * 设置胶囊自定义文字模板。空串 = 回到内置默认排版。
   *
   * 只做长度与类型收敛（`normalizeHudTemplate`）；语法对错由渲染层回报给
   * 设置页 —— 写盘这一层不该悄悄改写用户的模板。
   */
  async setHudTemplate(template: string): Promise<void> {
    await this.ensureLoaded()
    const next = normalizeHudTemplate(template)
    if (this.hudTpl === next) return
    this.hudTpl = next
    await this.persist()
  }

  /** 当前胶囊自定义模板；空串表示用内置默认排版。 */
  get hudTemplate(): string {
    return this.hudTpl
  }

  /** 客户端可见的快照（不含任何凭据）。 */
  snapshot(): {
    hiddenModels: string[]
    hudEnabled: boolean
    theme: CmdgoThemePreference
    hudPosition: CmdgoHudPosition
    hudTemplate: string
  } {
    return {
      hiddenModels: [...this.hidden].sort(),
      hudEnabled: this.hud,
      theme: this.themeMode,
      hudPosition: this.hudPos,
      hudTemplate: this.hudTpl,
    }
  }
}
