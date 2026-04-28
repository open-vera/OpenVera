import type { Command } from '../../commands.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: '打开宠物面板、摸摸它，或重新生成',
  argumentHint: '[pet|new|rare|best]',
  immediate: true,
  supportsNonInteractive: false,
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
