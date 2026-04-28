import { getGlobalConfig } from '../utils/config.js'
import {
  type Companion,
  type CompanionBones,
  type CompanionSoul,
  EYES,
  HATS,
  RARITIES,
  RARITY_WEIGHTS,
  type Rarity,
  type Species,
  SPECIES,
  STAT_NAMES,
  type StatName,
  type StoredCompanion,
} from './types.js'

// Mulberry32 — tiny seeded PRNG, good enough for picking ducks
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  if (typeof Bun !== 'undefined') {
    return Number(BigInt(Bun.hash(s)) & 0xffffffffn)
  }
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

function rollRarity(rng: () => number): Rarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0)
  let roll = rng() * total
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity]
    if (roll < 0) return rarity
  }
  return 'common'
}

const RARITY_FLOOR: Record<Rarity, number> = {
  common: 5,
  uncommon: 15,
  rare: 25,
  epic: 35,
  legendary: 50,
}

// One peak stat, one dump stat, rest scattered. Rarity bumps the floor.
function rollStats(
  rng: () => number,
  rarity: Rarity,
): Record<StatName, number> {
  const floor = RARITY_FLOOR[rarity]
  const peak = pick(rng, STAT_NAMES)
  let dump = pick(rng, STAT_NAMES)
  while (dump === peak) dump = pick(rng, STAT_NAMES)

  const stats = {} as Record<StatName, number>
  for (const name of STAT_NAMES) {
    if (name === peak) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    } else if (name === dump) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    } else {
      stats[name] = floor + Math.floor(rng() * 40)
    }
  }
  return stats
}

const SALT = 'friend-2026-401'
const DEFAULT_COMPANION_HATCHED_AT = Date.UTC(2026, 3, 1)
const DEFAULT_NAMES = [
  'Pico',
  'Mochi',
  'Kiki',
  'Nori',
  'Puff',
  'Toto',
  'Biscuit',
  'Pixel',
  'Pebble',
  'Clover',
  'Tinsel',
  'Comet',
  'Sprout',
  'Button',
  'Pickles',
  'Glimmer',
  'Pudding',
  'Maple',
  'Wisp',
  'Cricket',
  'Bubbles',
  'Fig',
  'Taro',
  'Doodle',
] as const
const SPECIES_NAMES: Record<Species, readonly string[]> = {
  duck: ['Quill', 'Paddle', 'Pebble'],
  goose: ['Gravy', 'Honk', 'Rascal'],
  blob: ['Gooey', 'Jelly', 'Mallow'],
  cat: ['Miso', 'Sable', 'Mittens'],
  dragon: ['Ember', 'Cinder', 'Scorch'],
  octopus: ['Inky', 'Tangle', 'Ripple'],
  owl: ['Noctis', 'Olive', 'Bramble'],
  penguin: ['Tux', 'Pebby', 'Flurry'],
  turtle: ['Moss', 'Shelly', 'Marble'],
  snail: ['Swirl', 'Dewdrop', 'Pace'],
  ghost: ['Wisp', 'Veil', 'Nimbus'],
  axolotl: ['Bloop', 'Lotl', 'Coral'],
  capybara: ['Mateo', 'Puddle', 'Basil'],
  cactus: ['Spike', 'Sagu', 'Needle'],
  robot: ['Servo', 'Pixel', 'Nova'],
  rabbit: ['Thumper', 'Clover', 'Velvet'],
  mushroom: ['Truffle', 'Button', 'Morel'],
  chonk: ['Biscuit', 'Mochi', 'Boulder'],
}
const SPECIES_VIBES: Record<Species, readonly string[]> = {
  duck: ['像经典的橡皮鸭调试搭子，总爱陪你把问题讲清楚。', '眼神亮晶晶的，一看到 bug 就想摇摇摆摆冲过去。'],
  goose: ['是个很有主见的混乱小怪兽，嗓门还不小。', '调皮又大胆，看到可疑代码就想先嘎两声。'],
  blob: ['软乎乎的一团，情绪感知却意外地敏锐。', '像会变形的小果冻，遇到再怪的场面都能适应。'],
  cat: ['表面高冷，真到卡壳时反而很会陪人。', '独立又克制，偶尔会给出很有用的嫌弃。'],
  dragon: ['小小一只却很有气场，坚信每个仓库都该有守护龙。', '心里像带着火苗，连小警告都能演出史诗感。'],
  octopus: ['像同时抓着六个念头的多线程选手。', '灵活又好奇，很擅长把一团乱麻慢慢理开。'],
  owl: ['像深夜坐镇的导师，观察总是沉稳又周到。', '聪明又警觉，最适合陪你熬夜专注。'],
  penguin: ['仿佛随时穿着正装准备参加代码评审。', '礼貌、整洁，而且非常在意边边角角是否干净。'],
  turtle: ['稳得像一块石头，很难被催着做出草率决定。', '耐心又踏实，特别适合长线 debug。'],
  snail: ['慢是故意的，因为它想把每个小细节都看清。', '温和又细致，最喜欢从容不迫地推进。'],
  ghost: ['安静、轻飘飘的，总在最需要的时候出现。', '像个神秘的旁观者，在对话边上轻轻飘过。'],
  axolotl: ['是只活力满满的水生小怪可爱担当。', '又萌又闹腾，还特别擅长给人打气。'],
  capybara: ['不管堆栈多吓人，它都是房间里最淡定的那位。', '松弛、温暖，专注感像在身边铺开一样。'],
  cactus: ['外表有点扎手，心里却意外地柔软。', '刚开始有些拘谨，熟了以后会很忠诚。'],
  robot: ['精准、讲究秩序，而且非常欣赏整洁系统。', '理性又可靠，对优雅逻辑有天然好感。'],
  rabbit: ['反应快得像弹簧，很难安静太久。', '精力旺盛又机警，喜欢一鼓作气往前冲。'],
  mushroom: ['像缩在提示框阴影里的安静观察者。', '平静、柔和，而且比表面看起来更会读空气。'],
  chonk: ['圆乎乎、倔脾气，是那种重量级情绪支撑。', '像一团抱起来很安心的小麻烦精，心其实很软。'],
}
const RARITY_VIBES: Record<Rarity, readonly string[]> = {
  common: ['气质朴素真诚，属于越看越顺眼的类型。', '带着一种很舒服的熟悉感。'],
  uncommon: ['比普通款多一点小巧思和自信。', '有种低调但明确的个人风格。'],
  rare: ['举手投足都带着“我确实不太一样”的感觉。', '像一次手气很好的命中，还很有个性。'],
  epic: ['一登场就有点戏剧张力，气场闪闪发亮。', '浑身都是主角感，想不注意到都难。'],
  legendary: ['看起来已经接近终端神话生物了。', '像那种万里挑一才会遇到的搭子。'],
}
const PEAK_STAT_VIBES: Record<StatName, readonly string[]> = {
  DEBUGGING: ['最强的本能就是嗅出问题到底坏在哪。', '很喜欢一路追到真正出错的那一行。'],
  PATIENCE: ['修东西从不急躁，说话也总是很温和。', '天生适合陪你打那种超长线的 debug。'],
  CHAOS: ['对奇怪气氛和离谱支线有天然亲近感。', '明明很不可预测，偏偏又让人觉得可爱。'],
  WISDOM: ['很会从眼前的混乱里看出更大的模式。', '有种小小终端贤者的味道。'],
  SNARK: ['代码一乱就忍不住来一句干巴巴的吐槽。', '那个眼神锐利到像能直接帮你 lint。'],
}
const LOW_STAT_VIBES: Record<StatName, readonly string[]> = {
  DEBUGGING: ['相比刨根问底，它更擅长情绪支持。', '比起拆解堆栈，它更喜欢在旁边给你打气。'],
  PATIENCE: ['进度一停下来就会有点坐不住。', '冷静等待并不是它最擅长的事。'],
  CHAOS: ['嘴上不说，其实比想象中更喜欢秩序。', '事情一旦太随机，它反而会先警觉起来。'],
  WISDOM: ['有时候会先冲出去，再慢慢补思考。', '更偏直觉派，而不是哲学家路线。'],
  SNARK: ['看着有点拽，心其实比外表软。', '就算表情不耐烦，出发点通常还是好的。'],
}
const RARE_OR_BETTER_RARITIES = new Set<Rarity>(['rare', 'epic', 'legendary'])

export type Roll = {
  bones: CompanionBones
  inspirationSeed: number
}

function rollFrom(rng: () => number): Roll {
  const rarity = rollRarity(rng)
  const bones: CompanionBones = {
    rarity,
    species: pick(rng, SPECIES),
    eye: pick(rng, EYES),
    hat: rarity === 'common' ? 'none' : pick(rng, HATS),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity),
  }
  return { bones, inspirationSeed: Math.floor(rng() * 1e9) }
}

// Called from three hot paths (500ms sprite tick, per-keystroke PromptInput,
// per-turn observer) with the same userId → cache the deterministic result.
let rollCache: { key: string; value: Roll } | undefined
export function roll(userId: string): Roll {
  const key = userId + SALT
  if (rollCache?.key === key) return rollCache.value
  const value = rollFrom(mulberry32(hashString(key)))
  rollCache = { key, value }
  return value
}

export function rollWithSeed(seed: string): Roll {
  return rollFrom(mulberry32(hashString(seed)))
}

function getPeakStat(stats: Record<StatName, number>): StatName {
  let best: StatName = STAT_NAMES[0]
  for (const stat of STAT_NAMES.slice(1)) {
    if (stats[stat] > stats[best]) best = stat
  }
  return best
}

function getLowestStat(stats: Record<StatName, number>): StatName {
  let lowest: StatName = STAT_NAMES[0]
  for (const stat of STAT_NAMES.slice(1)) {
    if (stats[stat] < stats[lowest]) lowest = stat
  }
  return lowest
}

export function isRareOrBetter(rarity: Rarity): boolean {
  return RARE_OR_BETTER_RARITIES.has(rarity)
}

export function generateCompanionSeed(
  predicate: (bones: CompanionBones) => boolean = () => true,
  maxAttempts = 2048,
): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seed = crypto.randomUUID()
    if (predicate(roll(seed).bones)) return seed
  }
  throw new Error('Failed to generate a matching buddy seed')
}

export function companionUserId(): string {
  const config = getGlobalConfig()
  return config.companionSeed ?? config.oauthAccount?.accountUuid ?? config.userID ?? 'anon'
}

function createDefaultCompanionSoul(
  userId: string,
  bones: CompanionBones,
): StoredCompanion {
  const rng = mulberry32(
    hashString(`${userId}:${bones.species}:${bones.rarity}:default-buddy`),
  )
  const peakStat = getPeakStat(bones.stats)
  const lowStat = getLowestStat(bones.stats)
  const names = [...SPECIES_NAMES[bones.species], ...DEFAULT_NAMES]
  const soul: CompanionSoul = {
    name: pick(rng, names),
    personality: [
      pick(rng, SPECIES_VIBES[bones.species]),
      pick(rng, RARITY_VIBES[bones.rarity]),
      pick(rng, PEAK_STAT_VIBES[peakStat]),
      pick(rng, LOW_STAT_VIBES[lowStat]),
    ].join(' '),
  }

  return {
    ...soul,
    hatchedAt: DEFAULT_COMPANION_HATCHED_AT,
  }
}

// Regenerate bones from userId, merge with stored soul. Bones never persist
// so species renames and SPECIES-array edits can't break stored companions,
// and editing config.companion can't fake a rarity.
export function getCompanion(): Companion | undefined {
  const userId = companionUserId()
  const { bones } = roll(userId)
  const stored = getGlobalConfig().companion ?? createDefaultCompanionSoul(userId, bones)
  // bones last so stale bones fields in old-format configs get overridden
  return { ...stored, ...bones }
}
