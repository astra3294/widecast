// 抖音上传页 DOM 侦察:提取输入框/按钮/富文本区,为发布适配器收集选择器
import { chromium } from 'playwright'

const ctx = await chromium.launchPersistentContext('C:/Users/白日梦想家/.widecast/browser-profiles/douyin', {
  headless: false,
  viewport: { width: 1280, height: 860 },
  locale: 'zh-CN',
})
const page = ctx.pages()[0] ?? await ctx.newPage()
console.log('打开上传页…')
await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(e => console.log('goto:', e.message))
await page.waitForTimeout(8000)
const dump = await page.evaluate(() => {
  const inputs = []
  document.querySelectorAll('input').forEach((el) => {
    inputs.push({ tag: 'input', type: el.type || '', name: el.name || '', id: el.id || '', placeholder: el.placeholder || '', cls: String(el.className || '').slice(0, 90) })
  })
  const textareas = []
  document.querySelectorAll('textarea').forEach((el) => {
    textareas.push({ tag: 'textarea', placeholder: el.placeholder || '', cls: String(el.className || '').slice(0, 90) })
  })
  const editables = []
  document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
    editables.push({ tag: 'contenteditable', text: String(el.textContent || '').trim().slice(0, 40), cls: String(el.className || '').slice(0, 90) })
  })
  const buttons = []
  document.querySelectorAll('button, [role="button"]').forEach((el) => {
    const text = String(el.textContent || '').trim().slice(0, 24)
    if (text) buttons.push({ tag: el.tagName, text, cls: String(el.className || '').slice(0, 90) })
  })
  return { url: location.href, title: document.title, inputs: inputs.slice(0, 30), textareas: textareas.slice(0, 10), editables: editables.slice(0, 10), buttons: buttons.slice(0, 40) }
})
console.log(JSON.stringify(dump, null, 2))
await ctx.close()
console.log('done')
