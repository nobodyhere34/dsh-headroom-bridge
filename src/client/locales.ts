/**
 * Locale bundles for the headroom bridge settings card.
 *
 * The card owns its own dictionary namespace: a card contributed by a plugin
 * outside the Plugins section package cannot lean on the section's copy, so the
 * shared card vocabulary (save/discard/overridden/…) is spelled here beside the
 * bridge-specific keys, exactly as the section spells it for its own cards.
 */

/** Locale keys the headroom card renders. */
export type HeadroomCardLocaleKey =
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed'
  | 'invalidNumber' | 'invalidValue'
  | 'headroomTitle' | 'headroomDescription'
  | 'mode' | 'modeHint' | 'enabled' | 'enabledHint'
  | 'baseUrl' | 'baseUrlHint' | 'timeoutMs' | 'timeoutMsHint'
  | 'minChars' | 'minCharsHint' | 'minSavingsRatio' | 'minSavingsRatioHint'
  | 'protectErrorOutputs' | 'protectErrorOutputsHint'
  | 'statusTitle' | 'statsMode' | 'statsEnabled' | 'statsProxy'
  | 'statsAttemptsFailures' | 'statsAdopted' | 'statsSavedChars'
  | 'statsLedgerEntries' | 'statsHealth' | 'healthUnknown'
  | 'statsUnreachable' | 'statsLoading' | 'statsFailed'
  | 'ledgerTitle' | 'ledgerEmpty'
  | 'chipCount' | 'chipOriginal' | 'chipExpired' | 'chipUnavailable'
  | 'ledgerActivity' | 'ledgerShowOriginal' | 'ledgerOriginalGone'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The headroom bridge card's copy. */
    'settings.plugins.headroom': HeadroomCardLocaleKey
  }
}

/** English copy. */
export const en: Record<HeadroomCardLocaleKey, string> = {
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  invalidValue: 'Pick one of the offered values, or leave blank to use the default.',
  headroomTitle: 'Headroom compression',
  headroomDescription: 'Content-aware compression of model-visible content.',
  mode: 'Mode',
  modeHint: 'Audit records savings only; live replaces accepted results.',
  enabled: 'Compression enabled',
  enabledHint: 'Master switch for both compression arms.',
  baseUrl: 'Proxy endpoint',
  baseUrlHint: 'Leave blank to use the default proxy.',
  timeoutMs: 'Request timeout (ms)',
  timeoutMsHint: 'How long one compression request may run before it is abandoned.',
  minChars: 'Minimum length (chars)',
  minCharsHint: 'Compress only text at least this long.',
  minSavingsRatio: 'Minimum savings ratio',
  minSavingsRatioHint: 'Replace only when the response saves at least this fraction.',
  protectErrorOutputs: 'Protect error outputs',
  protectErrorOutputsHint: 'Failed results stay verbatim.',
  statusTitle: 'Status',
  statsMode: 'Running mode',
  statsEnabled: 'Enabled',
  statsProxy: 'Proxy',
  statsAttemptsFailures: 'Attempts / failures',
  statsAdopted: 'Adopted',
  statsSavedChars: 'Chars saved',
  statsLedgerEntries: 'Ledger entries',
  statsHealth: 'Proxy health',
  healthUnknown: 'n/a',
  statsUnreachable: 'Status API unreachable.',
  statsLoading: 'Loading…',
  statsFailed: 'Status unavailable: {message}',
  ledgerTitle: 'Recent compressions',
  ledgerEmpty: 'No records yet.',
  chipCount: 'Compressed {count} results this turn · {before} → {after} chars (-{pct}%)',
  chipOriginal: 'Original ({count} chars) — the compressed form is the tool row above:',
  chipExpired: 'Original demoted after leaving the context window (metadata retained).',
  chipUnavailable: 'Original unavailable.',
  ledgerActivity: 'Recent operations',
  ledgerShowOriginal: 'Show original',
  ledgerOriginalGone: 'Original expired',
}

/** Simplified Chinese copy. */
export const zh: Record<HeadroomCardLocaleKey, string> = {
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  invalidValue: '请选择给出的值；留空表示使用默认值。',
  headroomTitle: 'Headroom 压缩',
  headroomDescription: '对模型可见内容做内容感知压缩。',
  mode: '模式',
  modeHint: '审计只记录节省；实况会替换被采纳的结果。',
  enabled: '启用压缩',
  enabledHint: '双臂总开关。',
  baseUrl: 'Proxy 地址',
  baseUrlHint: '留空则使用默认 Proxy 地址。',
  timeoutMs: '请求超时（毫秒）',
  timeoutMsHint: '单次压缩请求允许运行多久，超时即放弃。',
  minChars: '最小字符数',
  minCharsHint: '仅压缩达到该长度的文本。',
  minSavingsRatio: '最低节省比例',
  minSavingsRatioHint: '节省达到该比例才替换。',
  protectErrorOutputs: '保护错误输出',
  protectErrorOutputsHint: '失败结果保持原样。',
  statusTitle: '状态',
  statsMode: '运行模式',
  statsEnabled: '开关',
  statsProxy: 'Proxy',
  statsAttemptsFailures: '尝试/失败',
  statsAdopted: '已采纳',
  statsSavedChars: '节省字符',
  statsLedgerEntries: '台账条目',
  statsHealth: 'Proxy 健康',
  healthUnknown: 'n/a',
  statsUnreachable: '状态 API 不可达。',
  statsLoading: '加载中…',
  statsFailed: '状态不可用：{message}',
  ledgerTitle: '最近压缩',
  ledgerEmpty: '（暂无记录）',
  chipCount: '本轮压缩 {count} 处 · {before} → {after} 字符 (-{pct}%)',
  chipOriginal: '原始内容（{count} 字符）— 压缩后的形态即上方工具行所示：',
  chipExpired: '原文已出窗降级（台账仅保留元数据）。',
  chipUnavailable: '原文不可用。',
  ledgerActivity: '近期操作',
  ledgerShowOriginal: '查看原文',
  ledgerOriginalGone: '原文已过期',
}
