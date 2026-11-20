/**
 * dsh-rebase-tail —— 浏览器半边。
 *
 * 一个工具栏药丸 + 一个弹窗，共用同一个 store 座位：
 *  - `conversation.input.left`（list）—— 与"结构化""周期提示"并排的入口；
 *  - `conversation.input.dock`（list）—— 弹窗本体，没打开时返回 null 不占空间。
 *
 * 执行在宿主完成（`POST /plugins/dsh-rebase-tail/run`），浏览器只提交选项、
 * 显示结果。按钮与斜杠命令走同一段代码，不必两边各写一份。
 *
 * 三条纪律：
 * - 药丸规格照抄相邻控件（28px 高、`box-sizing: border-box`、
 *   `var(--dsw-radius-sm)`、12px 字号），否则在工具栏里会显得错位。
 * - 遮罩用 `position: fixed` 并 `createPortal` 到 body：
 *   `conversation.input.dock` 的祖先 `.composerSeat` 在 active 相位是
 *   `position: sticky; z-index: 7`，已经形成层叠上下文，就地渲染的遮罩
 *   挡不住侧栏和右侧面板。
 * - 不碰发送链路：不监听 `agent/pre-step`、不接管发送按钮、不读写会话草稿。
 *
 * @module dsh-rebase-tail/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-rebase-tail',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { createPortal } = require('react-dom')
    const { defineStore } = require('@deepseek-ai/dsh-client-store')

    /** 必须等于 host 包名：模块表按包身份对账。 */
    const name = 'dsh-rebase-tail'

    const NS = 'rebase-tail'

    /** 与 src/index.js 的 MAX_TITLE_LENGTH 同一数值：两边都拦一次，宿主才是权威。 */
    const MAX_TITLE_LENGTH = 80

    /** 与 src/index.js 的 PRESETS_ROUTE 同一字面量。 */
    const PRESETS_ROUTE = '/plugins/dsh-rebase-tail/presets'

    /** 与 src/index.js 的 RUN_ROUTE 同一字面量。 */
    const RUN_ROUTE = '/plugins/dsh-rebase-tail/run'

    /** 测试缝的落点：挂模块作用域，Cordis 分离调用下 `this` 是 undefined。 */
    let internals = null

    const CSS = `
/* 颜色一律取宿主的语义 token（packages/client/ui-theme/src/styles/design-platform.css）。
   宿主没有的变量不要臆造：写错名字不会报错，只会静默落进 fallback，深色主题下看起来"还行"、
   切到浅色或原生控件时就露馅。 */
.rt-root { display: inline-flex; align-items: center; }
.rt-pill {
  display: inline-flex; align-items: center; gap: 4px;
  height: 28px; box-sizing: border-box; padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  background: transparent; color: inherit;
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
  white-space: nowrap;
}
.rt-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rt-pill[data-open='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l4);
}
.rt-pill[disabled] { opacity: 0.5; cursor: not-allowed; }
.rt-mask {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-mask-1);
}
.rt-modal {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex; flex-direction: column;
  border-radius: var(--dsw-radius-lg);
  /* 原生 <select> 的弹层不读 CSS 背景色，只跟 color-scheme 走；
     显式钉住它，深色主题下才是深色列表而不是系统浅色。 */
  color-scheme: light;
  border: 0;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 13px; line-height: 1.5;
}
body[data-ds-dark-theme] .rt-modal { color-scheme: dark; }
.rt-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 13px; font-weight: 600;
}
.rt-spacer { flex: 1 1 auto; }
.rt-close {
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
  font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: var(--dsw-radius-sm);
}
.rt-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.rt-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.rt-lede { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.rt-row { display: flex; align-items: center; gap: 8px; }
/* 预设列表展开后这一行会变高：标签贴顶，才跟触发按钮对齐。 */
.rt-row-top { align-items: flex-start; }
.rt-row-top .rt-label { padding-top: 7px; }
.rt-label { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 62px; }
.rt-text {
  flex: 1 1 auto; min-width: 0; height: 26px; box-sizing: border-box; padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.rt-text:focus-visible, .rt-num:focus-visible, .rt-trigger:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
/* 预设选择器：自绘列表。原生 <select> 的弹层由浏览器自绘，配色只跟 color-scheme 走，
   选中行还会盖一层系统高亮，跟宿主菜单对不上。 */
.rt-picker { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-width: 0; }
.rt-trigger {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; cursor: pointer;
}
.rt-trigger:disabled { opacity: 0.55; cursor: default; }
.rt-trigger-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 用 CSS 三角形而不是字符：字体缺 ▾ 字形时会缩成一个小点。 */
.rt-caret {
  flex: 0 0 auto; width: 0; height: 0;
  border-left: 3.5px solid transparent; border-right: 3.5px solid transparent;
  border-top: 4.5px solid var(--dsw-alias-label-tertiary);
}
/* 内联展开而不是浮层：正文是 overflow:auto，绝对定位的列表会被裁掉下半截。 */
.rt-list {
  max-height: 240px; overflow: auto; padding: 4px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
}
.rt-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 5px 8px; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.rt-item:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover); }
.rt-item[aria-selected='true'] { background: var(--dsw-alias-interactive-bg-hover); font-weight: 600; }
.rt-item[disabled] { color: var(--dsw-alias-label-tertiary); cursor: default; }
.rt-item-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-item-note { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.rt-placeholder { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.rt-warn { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.rt-num {
  width: 84px; height: 26px; box-sizing: border-box; padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.rt-check { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; cursor: pointer; }
.rt-check input { margin: 3px 0 0; }
.rt-check small { color: var(--dsw-alias-label-tertiary); }
.rt-result {
  border-radius: var(--dsw-radius-md); padding: 8px 10px; font-size: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  white-space: pre-wrap; word-break: break-word;
}
.rt-toast {
  position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%);
  max-width: min(640px, calc(100vw - 48px));
  padding: 10px 16px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 13px; line-height: 1.5; z-index: 10000; white-space: pre-wrap; word-break: break-word;
}
.rt-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.rt-btn {
  height: 28px; padding: 0 12px; box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer;
}
.rt-btn:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover); }
.rt-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
.rt-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted);
}
.rt-btn-primary:hover:not([disabled]) { background: var(--dsw-alias-button-primary-hover); }
`

    /** 挂样式表。`data-plugin` 必须打：模块系统按它认领 <style>，否则会被别的插件带走。 */
    function mountStyles() {
      if (typeof document === 'undefined') return () => {}
      const selector = 'style[data-plugin="dsh-rebase-tail"]'
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-rebase-tail'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /** 会话内的状态。药丸切换 `open`，弹窗读同一个 store 实例。 */
    function createStore() {
      return defineStore({
        init: () => ({
          open: false,
          /** 保留轮次。空串表示压缩点之后的全部完整轮次。 */
          turns: '',
          /** 新会话的名称。空串表示沿用旧标题加" · 尾部会话"后缀。 */
          title: '',
          /** 选定的预设 id。空串表示"跟随原会话"。 */
          preset: '',
          /** 可选预设清单（打开弹窗时拉一次）。 */
          presets: [],
          /** 预设列表是否展开。 */
          presetOpen: false,
          /** 是否带上压缩摘要（不勾就看不清压缩点之前的结论）。 */
          includeSummary: true,
          /** 是否把没跑完那一轮的前半截也接上。 */
          includeInterruptedTurn: true,
          /** idle | working | done | failed */
          phase: 'idle',
          text: '',
          /** 成功后自动关闭弹窗，结果用 toast 短暂提示。 */
          toast: '',
        }),
        actions: {
          openDialog: (draft) => { draft.open = true; draft.phase = 'idle'; draft.text = ''; draft.toast = '' },
          closeDialog: (draft) => { draft.open = false; draft.phase = 'idle'; draft.text = '' },
          setTurns: (draft, value) => { draft.turns = value },
          setTitle: (draft, value) => { draft.title = value },
          setPreset: (draft, value) => { draft.preset = value; draft.presetOpen = false },
          setPresetOpen: (draft, value) => { draft.presetOpen = value },
          setPresets: (draft, value) => { draft.presets = value },
          toggleSummary: (draft) => { draft.includeSummary = !draft.includeSummary },
          toggleInterrupted: (draft) => { draft.includeInterruptedTurn = !draft.includeInterruptedTurn },
          start: (draft) => { draft.phase = 'working'; draft.text = '' },
          finish: (draft, text) => {
            draft.open = false
            draft.phase = 'done'
            draft.text = ''
            draft.toast = text
          },
          clearToast: (draft) => { draft.toast = '' },
          fail: (draft, text) => { draft.phase = 'failed'; draft.text = text },
        },
      })
    }

    /** 药丸图标：两条横杠 + 向下的箭头，暗示切掉上半截、保留下半截。 */
    function pillIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 2, y: 3, width: 12, height: 1.6, rx: 0.8 }),
        h('rect', { x: 4, y: 6.4, width: 8, height: 1.6, rx: 0.8 }),
        h('path', { d: 'M8 9.2l2.6 2.6H9.3V14H6.7v-2.2H5.4z' }))
    }

    /**
     * 入口药丸。
     * @param store - store 座位声明。
     * @returns 组件。
     */
    function makePill(store) {
      return function RebaseTailPill(props) {
        const { sessionId, useStore, actions } = props || {}
        const open = typeof useStore === 'function' ? useStore((state) => state.open) : false
        const disabled = sessionId === undefined || sessionId === null || !actions
        const toast = typeof useStore === 'function' ? useStore((state) => state.toast) : ''
        React.useEffect(() => {
          if (toast === '' || !actions) return undefined
          const timer = setTimeout(() => { actions.clearToast() }, 12000)
          return () => { clearTimeout(timer) }
        }, [toast])
        return h('span', { className: 'rt-root' }, toast !== '' && typeof document !== 'undefined'
          ? createPortal(h('div', { className: 'rt-toast', role: 'status', 'aria-live': 'polite' }, toast), document.body)
          : null,
          h('button', {
            type: 'button',
            className: 'rt-pill',
            'data-open': String(open === true),
            title: '把最近一次压缩之后的对话分切成一个新会话',
            'aria-haspopup': 'dialog',
            'aria-expanded': open === true,
            disabled,
            // 不抢输入框焦点。
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { if (!disabled) actions.openDialog() },
          }, pillIcon(), h('span', null, '分切尾部')))
      }
    }

    /**
     * 预设 id 对应的显示名。空串是"跟随原会话"。
     * @param presets - 清单。
     * @param id - 当前选中的 id。
     * @returns 给按钮显示的文字。
     */
    function presetLabelFor(presets, id) {
      if (typeof id !== 'string' || id.length === 0) return '跟随原会话'
      const row = presets.find(candidate => candidate.id === id)
      return row === undefined ? id : row.label
    }

    /**
     * 弹窗。挂在 `conversation.input.dock`。
     * @param store - 与药丸同一个 store 座位。
     * @returns 组件。
     */
    function makeDialog(store) {
      return function RebaseTailDialog(props) {
        const { sessionId, useStore, actions } = props || {}
        const read = typeof useStore === 'function' ? useStore : () => undefined
        // hook 全部在提前返回之前调用，数量不随状态变化。
        const open = read((state) => state.open) === true
        const turns = read((state) => state.turns) ?? ''
        const title = read((state) => state.title) ?? ''
        const preset = read((state) => state.preset) ?? ''
        const presets = read((state) => state.presets) ?? []
        const presetOpen = read((state) => state.presetOpen) === true
        const includeSummary = read((state) => state.includeSummary) !== false
        const includeInterruptedTurn = read((state) => state.includeInterruptedTurn) !== false
        const phase = read((state) => state.phase) ?? 'idle'
        const text = read((state) => state.text) ?? ''
        const numberRef = React.useRef(null)
        const titleRef = React.useRef(null)
        const presetRef = React.useRef(null)

        React.useEffect(() => {
          if (!open) return undefined
          const timer = setTimeout(() => { titleRef.current?.focus() }, 0)
          return () => { clearTimeout(timer) }
        }, [open])

        // 点列表外面收起。用捕获阶段，免得被内层按钮的 click 先吃掉。
        React.useEffect(() => {
          if (!presetOpen) return undefined
          const onDown = (event) => {
            if (presetRef.current?.contains(event.target)) return
            actions?.setPresetOpen(false)
          }
          document.addEventListener('mousedown', onDown, true)
          return () => { document.removeEventListener('mousedown', onDown, true) }
        }, [presetOpen])

        // 打开时拉一次可选预设：宿主可能随时增删预设，缓存太久会显示过时清单。
        React.useEffect(() => {
          if (!open || !actions) return undefined
          let cancelled = false
          void (async () => {
            try {
              const response = await fetch(PRESETS_ROUTE, { headers: { accept: 'application/json' } })
              const payload = await response.json().catch(() => null)
              if (cancelled || payload?.ok !== true || !Array.isArray(payload.presets)) return
              actions.setPresets(payload.presets.map(row => ({
                id: String(row.id),
                label: typeof row.name === 'string' && row.name.length > 0 ? row.name : String(row.id),
                ...(typeof row.description === 'string' ? { description: row.description } : {}),
                ...(typeof row.broken === 'string' ? { broken: row.broken } : {}),
              })))
            } catch {
              // 拉不到就只显示"跟随原会话"，分切本身不受影响。
            }
          })()
          return () => { cancelled = true }
        }, [open])

        if (!open) return null

        const working = phase === 'working'
        const run = async () => {
          if (working || !actions) return
          const trimmed = String(turns).trim()
          let parsedTurns
          if (trimmed.length > 0) {
            parsedTurns = Number(trimmed)
            if (!Number.isSafeInteger(parsedTurns) || parsedTurns < 1) {
              actions.fail('保留轮次要么留空，要么填一个大于 0 的整数。')
              return
            }
          }
          const trimmedTitle = String(title).trim()
          if (trimmedTitle.length > MAX_TITLE_LENGTH) {
            actions.fail('新会话名称最长 ' + String(MAX_TITLE_LENGTH) + ' 个字符。')
            return
          }
          actions.start()
          try {
            const response = await fetch(RUN_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sessionId,
                ...(parsedTurns === undefined ? {} : { turns: parsedTurns }),
                ...(trimmedTitle.length === 0 ? {} : { title: trimmedTitle }),
                ...(preset.length === 0 ? {} : { preset }),
                includeSummary,
                includeInterruptedTurn,
              }),
            })
            const payload = await response.json().catch(() => null)
            const message = typeof payload?.text === 'string' && payload.text.length > 0
              ? payload.text
              : (response.ok ? '已执行，但宿主没有返回说明。' : '宿主返回 ' + String(response.status) + '。')
            if (response.ok && payload?.ok === true) actions.finish(message)
            else actions.fail(message)
          } catch (error) {
            actions.fail('请求没有发出去：' + String((error && error.message) || error))
          }
        }

        const checkbox = (checked, onToggle, label, hint) => h('label', { className: 'rt-check' },
          h('input', { type: 'checkbox', checked, disabled: working, onChange: () => { onToggle() } }),
          h('span', null, label, hint === undefined ? null : h('small', null, '　' + hint)))

        const modal = h('div', {
          className: 'rt-mask',
          onClick: (event) => { if (event.target === event.currentTarget && !working) actions.closeDialog() },
          onKeyDown: (event) => { if (event.key === 'Escape' && !working) actions.closeDialog() },
        },
          h('div', { className: 'rt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '分切尾部会话' },
            h('div', { className: 'rt-head' },
              h('span', null, '分切尾部会话'),
              h('span', { className: 'rt-spacer' }),
              h('button', {
                type: 'button', className: 'rt-close', title: '关闭', disabled: working,
                onMouseDown: (event) => { event.preventDefault() },
                onClick: () => { actions.closeDialog() },
              }, '×')),
            h('div', { className: 'rt-body' },
              h('div', { className: 'rt-lede' },
                '把最近一次压缩点之后的对话搬进一个新会话。压缩之前的事件不再出现在新会话里，'
                + '所以它不会背着旧日志继续跑。原会话不受影响。'),
              h('div', { className: 'rt-row' },
                h('span', { className: 'rt-label' }, '名称'),
                h('input', {
                  ref: titleRef,
                  className: 'rt-text',
                  type: 'text',
                  value: title,
                  maxLength: MAX_TITLE_LENGTH,
                  disabled: working,
                  placeholder: '留空＝旧标题 +「 · 尾部会话」',
                  onChange: (event) => { actions.setTitle(event.target.value) },
                  onKeyDown: (event) => { if (event.key === 'Enter') void run() },
                })),
              h('div', { className: 'rt-row rt-row-top' },
                h('span', { className: 'rt-label' }, '预设'),
                // 原生 <select> 的展开列表是浏览器自绘的，配色只跟 color-scheme 走、
                // 选中行还盖着一层系统高亮；改用自绘列表才能跟宿主菜单一致。
                h('div', { className: 'rt-picker', ref: presetRef },
                  h('button', {
                    type: 'button',
                    className: 'rt-text rt-trigger',
                    disabled: working,
                    'aria-haspopup': 'listbox',
                    'aria-expanded': presetOpen ? 'true' : 'false',
                    onClick: () => { actions.setPresetOpen(!presetOpen) },
                    onKeyDown: (event) => {
                      if (event.key === 'Escape' && presetOpen) { event.stopPropagation(); actions.setPresetOpen(false) }
                    },
                  },
                  h('span', { className: 'rt-trigger-label' }, presetLabelFor(presets, preset)),
                  h('span', { className: 'rt-caret', 'aria-hidden': 'true' })),
                  presetOpen ? h('div', { className: 'rt-list', role: 'listbox' },
                    ...[{ id: '', label: '跟随原会话' }, ...presets].map(row => h('button', {
                      key: row.id || '__follow',
                      type: 'button',
                      role: 'option',
                      'aria-selected': (row.id || '') === (preset || '') ? 'true' : 'false',
                      className: 'rt-item',
                      disabled: typeof row.broken === 'string',
                      onClick: () => { actions.setPreset(row.id || '') },
                    },
                    h('span', { className: 'rt-item-label' }, row.label),
                    typeof row.broken === 'string' ? h('span', { className: 'rt-item-note' }, '不可用') : null))
                  ) : null)),
              h('div', { className: 'rt-row' },
                h('span', { className: 'rt-label' }, '保留轮次'),
                h('input', {
                  ref: numberRef,
                  className: 'rt-num',
                  type: 'number',
                  min: 1,
                  step: 1,
                  value: turns,
                  disabled: working,
                  placeholder: '全部',
                  onChange: (event) => { actions.setTurns(event.target.value) },
                  onKeyDown: (event) => { if (event.key === 'Enter') void run() },
                }),
                h('span', { className: 'rt-lede' }, '留空＝压缩点之后的全部完整轮次')),
              checkbox(includeSummary, () => { actions.toggleSummary() }, '带上压缩摘要', '不然新会话看不到压缩点之前的结论'),
              checkbox(includeInterruptedTurn, () => { actions.toggleInterrupted() }, '接上没跑完的那一轮', '不勾则只保留完整轮次'),
              text.length === 0 ? null : h('div', { className: 'rt-result', 'data-tone': phase === 'failed' ? 'error' : 'info' }, text)),
            h('div', { className: 'rt-foot' },
              h('button', {
                type: 'button', className: 'rt-btn rt-btn-primary', disabled: working,
                onMouseDown: (event) => { event.preventDefault() },
                onClick: () => { void run() },
              }, working ? '分切中…' : '开始分切'),
              h('span', { className: 'rt-spacer' }),
              h('button', {
                type: 'button', className: 'rt-btn', disabled: working,
                onMouseDown: (event) => { event.preventDefault() },
                onClick: () => { actions.closeDialog() },
              }, '取消'))))
        return typeof document === 'undefined' ? modal : createPortal(modal, document.body)
      }
    }

    return {
      name,
      // 只声明真正用到的服务。
      inject: ['slots'],
      /** 测试缝：`apply` 跑完之后才有值。 */
      get __internals() { return internals },
      apply(ctx) {
        // HMR 会重跑 apply 而不先卸载旧实例：先拆掉上一份，避免槽位重复注册。
        try {
          if (typeof window.__RT_DISPOSE__ === 'function') window.__RT_DISPOSE__()
        } catch {
          /* 旧实例已经烂了也不影响新实例 */
        }
        const disposers = []
        const own = (fn, label) => {
          const dispose = ctx.effect(fn, label)
          if (typeof dispose === 'function') disposers.push(dispose)
        }
        window.__RT_DISPOSE__ = () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              /* 逐个拆，坏一个不影响其余 */
            }
          }
        }

        const store = createStore()

        own(() => mountStyles(), NS + ': styles')

        own(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: NS,
          // 结构化提示词插件是 20、硬邦邦是 30～31：排在它们右边。
          order: 40,
          label: () => '分切尾部',
          store,
        }, makePill(store))), NS + ': composer pill')

        own(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: NS,
          // 队列面板是 20、结构化插件是 21：取 22 钉在它们之后。
          order: 22,
          label: () => '分切尾部',
          store,
        }, makeDialog(store))), NS + ': dialog')

        internals = { RUN_ROUTE, createStore, CSS }
      },
    }
  },
})
