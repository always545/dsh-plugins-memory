/**
 * Configuration for the project-memory plugin.
 *
 * The plugin deliberately exports no `Config` schema: a profile-installed
 * bundle cannot resolve `@deepseek-ai/schemastery`, and an unvalidated loader
 * config would otherwise reach `apply()` as-is. Every value is normalized here
 * instead, so a malformed patch still activates with documented defaults.
 */

/** Documented defaults; the README repeats this table. */
export const DEFAULT_CONFIG = Object.freeze({
  directoryName: 'memory',
  language: 'zh',
  scaffoldExistingProjects: false,
  injectPrompt: true,
  sectionOrder: 10150,
  enableTools: true,
  enableDreamingCommand: true,
  autoRecord: true,
  recordToolNames: ['write', 'edit'],
  changeWaitMs: 800,
  includeDiff: true,
  diffFiles: 2,
  diffMaxChars: 2048,
  diffMaxLines: 40,
  maxFilesPerRecord: 50,
  maxSummaryChars: 200,
  recentRetentionHours: 24,
  maxAgeDays: 45,
  maxShortTermRecords: 300,
  forgetMode: 'archive',
  archiveMaxRecords: 2000,
  archiveMaxAgeDays: 365,
  injectCurrentFiles: 10,
  injectRecentTurns: 3,
  dreamingFocusMaxChars: 200,
  dreamingCooldownMs: 120000,
  maxInjectBytes: 22528,
  maxLongTermInjectBytes: 16384,
  maxShortTermInjectBytes: 4096,
  maxLongTermBytes: 65536,
  maxSourceBytes: 1048576,
  maxReadBytes: 65536,
})

const LANGUAGES = new Set(['zh', 'en'])
const FORGET_MODES = new Set(['archive', 'drop'])

/**
 * Coerce a finite number in a range, falling back to the documented default.
 * @param {unknown} value candidate
 * @param {number} fallback default
 * @param {number} min inclusive minimum
 * @param {number} [max] inclusive maximum
 * @returns {number} normalized value
 */
function numberIn(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return Math.floor(n)
}

/**
 * @param {unknown} value candidate
 * @param {boolean} fallback default
 * @returns {boolean} normalized value
 */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * A directory name that is exactly one safe path segment.
 * @param {unknown} value candidate
 * @param {string} fallback default
 * @returns {string} normalized value
 */
function directoryNameOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return fallback
  if (/[\\/\u0000]/.test(trimmed)) return fallback
  return trimmed
}

/**
 * Normalize one raw loader config into the complete effective configuration.
 * Unknown keys are ignored; every returned key is present.
 * @param {unknown} raw loader config value, usually `{}`
 * @returns {typeof DEFAULT_CONFIG} effective configuration
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const language = LANGUAGES.has(input.language) ? input.language : DEFAULT_CONFIG.language
  const recordToolNames = Array.isArray(input.recordToolNames)
    ? [...new Set(input.recordToolNames.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))]
    : []
  return {
    directoryName: directoryNameOr(input.directoryName, DEFAULT_CONFIG.directoryName),
    language,
    scaffoldExistingProjects: booleanOr(input.scaffoldExistingProjects, DEFAULT_CONFIG.scaffoldExistingProjects),
    injectPrompt: booleanOr(input.injectPrompt, DEFAULT_CONFIG.injectPrompt),
    sectionOrder: numberIn(input.sectionOrder, DEFAULT_CONFIG.sectionOrder, -100000, 100000),
    enableTools: booleanOr(input.enableTools, DEFAULT_CONFIG.enableTools),
    enableDreamingCommand: booleanOr(input.enableDreamingCommand, DEFAULT_CONFIG.enableDreamingCommand),
    autoRecord: booleanOr(input.autoRecord, DEFAULT_CONFIG.autoRecord),
    recordToolNames: recordToolNames.length ? recordToolNames : [...DEFAULT_CONFIG.recordToolNames],
    changeWaitMs: numberIn(input.changeWaitMs, DEFAULT_CONFIG.changeWaitMs, 0, 10000),
    includeDiff: booleanOr(input.includeDiff, DEFAULT_CONFIG.includeDiff),
    diffFiles: numberIn(input.diffFiles, DEFAULT_CONFIG.diffFiles, 0, 20),
    diffMaxChars: numberIn(input.diffMaxChars, DEFAULT_CONFIG.diffMaxChars, 0, 65536),
    diffMaxLines: numberIn(input.diffMaxLines, DEFAULT_CONFIG.diffMaxLines, 0, 1000),
    maxFilesPerRecord: numberIn(input.maxFilesPerRecord, DEFAULT_CONFIG.maxFilesPerRecord, 1, 500),
    maxSummaryChars: numberIn(input.maxSummaryChars, DEFAULT_CONFIG.maxSummaryChars, 1, 2000),
    recentRetentionHours: numberIn(input.recentRetentionHours, DEFAULT_CONFIG.recentRetentionHours, 1, 8760),
    maxAgeDays: numberIn(input.maxAgeDays, DEFAULT_CONFIG.maxAgeDays, 1, 3650),
    maxShortTermRecords: numberIn(input.maxShortTermRecords, DEFAULT_CONFIG.maxShortTermRecords, 1, 5000),
    forgetMode: FORGET_MODES.has(input.forgetMode) ? input.forgetMode : DEFAULT_CONFIG.forgetMode,
    archiveMaxRecords: numberIn(input.archiveMaxRecords, DEFAULT_CONFIG.archiveMaxRecords, 0, 100000),
    archiveMaxAgeDays: numberIn(input.archiveMaxAgeDays, DEFAULT_CONFIG.archiveMaxAgeDays, 1, 10000),
    injectCurrentFiles: numberIn(input.injectCurrentFiles, DEFAULT_CONFIG.injectCurrentFiles, 0, 100),
    injectRecentTurns: numberIn(input.injectRecentTurns, DEFAULT_CONFIG.injectRecentTurns, 0, 100),
    dreamingFocusMaxChars: numberIn(input.dreamingFocusMaxChars, DEFAULT_CONFIG.dreamingFocusMaxChars, 0, 2000),
    dreamingCooldownMs: numberIn(input.dreamingCooldownMs, DEFAULT_CONFIG.dreamingCooldownMs, 1000, 3600000),
    maxInjectBytes: numberIn(input.maxInjectBytes, DEFAULT_CONFIG.maxInjectBytes, 1024, 262144),
    maxLongTermInjectBytes: numberIn(input.maxLongTermInjectBytes, DEFAULT_CONFIG.maxLongTermInjectBytes, 0, 262144),
    maxShortTermInjectBytes: numberIn(input.maxShortTermInjectBytes, DEFAULT_CONFIG.maxShortTermInjectBytes, 0, 262144),
    maxLongTermBytes: numberIn(input.maxLongTermBytes, DEFAULT_CONFIG.maxLongTermBytes, 1024, 1048576),
    maxSourceBytes: numberIn(input.maxSourceBytes, DEFAULT_CONFIG.maxSourceBytes, 1024, 16777216),
    maxReadBytes: numberIn(input.maxReadBytes, DEFAULT_CONFIG.maxReadBytes, 1024, 16777216),
  }
}
