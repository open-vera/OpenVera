import { isEnvDefinedFalsy } from './envUtils.js'

export function isBuddyEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_CODE_DISABLE_BUDDY)
}

export function isComputerUseEnabled(): boolean {
  return (
    process.platform === 'darwin' &&
    !isEnvDefinedFalsy(process.env.CLAUDE_CODE_DISABLE_COMPUTER_USE)
  )
}
