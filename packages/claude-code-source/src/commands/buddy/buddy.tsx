import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import {
  generateCompanionSeed,
  getCompanion,
  isRareOrBetter,
} from '../../buddy/companion.js'
import { renderSprite } from '../../buddy/sprites.js'
import {
  HAT_LABELS,
  RARITY_COLORS,
  RARITY_LABELS,
  RARITY_STARS,
  SPECIES_LABELS,
  STAT_LABELS,
  STAT_NAMES,
} from '../../buddy/types.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Box, Text, useInput } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'

type BuddyAction = 'pet' | 'new' | 'rare' | 'best'

function formatCompanion(companion: NonNullable<ReturnType<typeof getCompanion>>): string {
  return `${companion.name} ${RARITY_STARS[companion.rarity]}（${SPECIES_LABELS[companion.species]}）`
}

function buildStatBar(value: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(value / 10)))
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function applyBuddyAction(
  action: BuddyAction,
  setAppState: LocalJSXCommandContext['setAppState'],
): { companion: NonNullable<ReturnType<typeof getCompanion>>; notice: string } | null {
  if (action === 'new' || action === 'rare' || action === 'best') {
    const seed =
      action === 'rare'
        ? generateCompanionSeed(bones => isRareOrBetter(bones.rarity))
        : action === 'best'
          ? generateCompanionSeed(bones => bones.rarity === 'legendary')
        : generateCompanionSeed()

    saveGlobalConfig(current => {
      const { companion, ...rest } = current
      return {
        ...rest,
        companionSeed: seed,
      }
    })

    const rerolled = getCompanion()
    if (!rerolled) return null

    setAppState(prev => ({
      ...prev,
      companionReaction: `${rerolled.name} 闪着小星星出现了。`,
      companionPetAt: undefined,
    }))

    return {
      companion: rerolled,
      notice: `${action === 'best' ? '顶级重抽' : action === 'rare' ? '稀有重抽' : '重新生成'}：${formatCompanion(rerolled)}。`,
    }
  }

  const companion = getCompanion()
  if (!companion) return null

  setAppState(prev => ({
    ...prev,
    companionPetAt: Date.now(),
    companionReaction: `${companion.name} 开心地精神起来了。`,
  }))

  return {
    companion,
    notice: `你摸了摸 ${formatCompanion(companion)}。`,
  }
}

function BuddyDialog({
  onDone,
  context,
  initialCompanion,
  initialNotice,
}: {
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
  initialCompanion: NonNullable<ReturnType<typeof getCompanion>>
  initialNotice?: string
}): React.ReactNode {
  const [companion, setCompanion] = React.useState(initialCompanion)
  const [notice, setNotice] = React.useState(initialNotice)

  const runAction = React.useCallback(
    (action: BuddyAction) => {
      const result = applyBuddyAction(action, context.setAppState)
      if (!result) return
      setCompanion(result.companion)
      setNotice(result.notice)
    },
    [context.setAppState],
  )

  const handlePet = React.useCallback(() => runAction('pet'), [runAction])
  const handleNew = React.useCallback(() => runAction('new'), [runAction])
  const handleRare = React.useCallback(() => runAction('rare'), [runAction])
  const handleBest = React.useCallback(() => runAction('best'), [runAction])

  useKeybinding('confirm:yes', handlePet, {
    context: 'Confirmation',
  })

  useInput(input => {
    if (input === 'r') {
      handleNew()
    } else if (input === 'R') {
      handleRare()
    } else if (input === 'b' || input === 'B') {
      handleBest()
    }
  })

  const sprite = renderSprite(companion, 0)
  const headerLeft = `${RARITY_STARS[companion.rarity]} ${RARITY_LABELS[companion.rarity]}`
  const headerRight = SPECIES_LABELS[companion.species]
  const extraFlags = [
    companion.shiny ? '闪光' : null,
    companion.hat !== 'none' ? `帽子 ${HAT_LABELS[companion.hat]}` : null,
  ]
    .filter(Boolean)
    .join('  ')

  return (
    <Dialog
      title="宠物伙伴"
      subtitle="陪你写代码的小搭子。"
      onCancel={() => onDone()}
      color={RARITY_COLORS[companion.rarity]}
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="摸摸" />
          <KeyboardShortcutHint shortcut="r" action="重抽" />
          <KeyboardShortcutHint shortcut="Shift+R" action="稀有重抽" />
          <KeyboardShortcutHint shortcut="b" action="顶级重抽" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="关闭"
          />
        </Byline>
      )}
    >
      {notice ? (
        <Box>
          <Text color={RARITY_COLORS[companion.rarity]}>{notice}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        <Text bold>{`${headerLeft.padEnd(18)}${headerRight}`}</Text>
        {extraFlags ? <Text dimColor>{extraFlags}</Text> : null}
      </Box>

      <Box flexDirection="column">
        {sprite.map((line, i) => (
          <Text key={i} color={RARITY_COLORS[companion.rarity]}>
            {line}
          </Text>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold>{companion.name}</Text>
        <Text dimColor italic>{`"${companion.personality}"`}</Text>
      </Box>

      <Box flexDirection="column">
        {STAT_NAMES.map(stat => (
          <Text key={stat}>{`${STAT_LABELS[stat].padEnd(4)} ${buildStatBar(companion.stats[stat])} ${String(companion.stats[stat]).padStart(3)}`}</Text>
        ))}
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const normalizedArgs = args.trim().toLowerCase()

  if (
    normalizedArgs !== '' &&
    normalizedArgs !== 'pet' &&
    normalizedArgs !== 'new' &&
    normalizedArgs !== 'rare' &&
    normalizedArgs !== 'best'
  ) {
    onDone('用法：/buddy、/buddy pet、/buddy new、/buddy rare、/buddy best')
    return null
  }

  let initialNotice: string | undefined
  if (
    normalizedArgs === 'pet' ||
    normalizedArgs === 'new' ||
    normalizedArgs === 'rare' ||
    normalizedArgs === 'best'
  ) {
    const result = applyBuddyAction(normalizedArgs, context.setAppState)
    if (!result) {
      onDone('当前会话里宠物不可用。')
      return null
    }
    initialNotice = result.notice
  }

  const companion = getCompanion()
  if (!companion) {
    onDone('当前会话里宠物不可用。')
    return null
  }

  return (
    <BuddyDialog
      onDone={onDone}
      context={context}
      initialCompanion={companion}
      initialNotice={initialNotice}
    />
  )
}
