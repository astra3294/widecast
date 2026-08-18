/**
 * Widecast 本地服务认证。
 *
 * 服务只绑定 loopback，但 loopback 上的其他本地进程也可能访问端口，
 * 因此 DSH 客户端与服务之间仍使用本机 token。token 默认保存在
 * WIDECAST_HOME/server-token，也可以由 WIDECAST_TOKEN 显式注入。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SERVER_TOKEN_FILENAME = 'server-token'

export function serverTokenPath(baseDir: string): string {
  return join(baseDir, SERVER_TOKEN_FILENAME)
}

export function getOrCreateServerToken(baseDir: string): string {
  const fromEnvironment = process.env.WIDECAST_TOKEN?.trim()
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment

  mkdirSync(baseDir, { recursive: true })
  const file = serverTokenPath(baseDir)
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return existing
  }

  const token = randomBytes(32).toString('hex')
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}

export function readServerToken(baseDir: string): string | undefined {
  const fromEnvironment = process.env.WIDECAST_TOKEN?.trim()
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
  try {
    const token = readFileSync(serverTokenPath(baseDir), 'utf8').trim()
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}
