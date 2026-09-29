/**
 * Structured logger utility built on loglevel.
 *
 * Usage:
 *   import { createLogger } from '@/utils/logger'
 *   const log = createLogger('visualization')
 *   log.debug('chart ready')
 *   log.warn('missing mapping')
 *   log.error('load failed', err)
 *
 * Log level is controlled by the VITE_LOG_LEVEL env variable.
 * Defaults to 'warn' in production and 'debug' in development.
 */

import loglevel from 'loglevel'

const isDev = import.meta.env.DEV

// Global default: warn in prod, debug in dev
const globalLevel = (import.meta.env.VITE_LOG_LEVEL as loglevel.LogLevelDesc | undefined)
  ?? (isDev ? 'debug' : 'warn')

loglevel.setDefaultLevel(globalLevel)

/**
 * Create a namespaced child logger.
 * Each module gets its own logger instance so levels can be tuned individually.
 */
export function createLogger(name: string): loglevel.Logger {
  const logger = loglevel.getLogger(name)
  // Inherit global level unless already overridden
  if (logger.getLevel() > loglevel.getLevel()) {
    logger.setLevel(loglevel.getLevel())
  }
  return logger
}
