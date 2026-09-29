/**
 * fsrs — FSRS（Free Spaced Repetition Scheduler, v5 公式 + 官方默认参数）的纯函数实现。
 *
 * ★ 为什么换：旧调度是固定 7 档间隔（1/2/4/7/15/30/60 天，`ebbinghaus.ts`），每个词条、每个人
 *   走同一条曲线——难词和易词同一个节奏，记得牢的被反复催、快忘的却要等满间隔。FSRS 给每个词条
 *   两个状态量：**稳定性 S**（天；记忆保持率掉到 90% 要多少天）与**难度 D**（1–10），每次复习按
 *   「这次记没记住 + 复习时的实际可提取度 R」更新它们，间隔由目标保持率反推。
 * ★ 与旧阶段（stage）的关系：stage 仍然保留——卡牌、知识大陆、概览柱状图都以它为轴，改掉会牵动
 *   整个游戏层；FSRS 只接管「下次什么时候复习」与「现在还记得几成」这两件事。
 * ★ 这里只放公式，零 IO；服务端 `learning/term-review.ts` 负责读写，前端也能直接调来算预测。
 */

/** FSRS-5 官方默认参数 w0..w18（open-spaced-repetition/fsrs-rs 默认值） */
export const FSRS_DEFAULT_W: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11,
  0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

/** 目标保持率：按这个概率「到期时还记得」来排间隔（FSRS 社区默认 0.9） */
export const FSRS_TARGET_RETENTION = 0.9;
/** 间隔上限（天）：再稳的词条也一年内见一次 */
export const FSRS_MAX_INTERVAL = 365;

const DECAY = -0.5;
const FACTOR = 19 / 81; // 使 R(S, S) = 0.9

/** 评分：1 忘了 / 2 困难 / 3 记得 / 4 轻松 */
export type FsrsGrade = 1 | 2 | 3 | 4;

export interface FsrsState {
  /** 稳定性（天） */
  stability: number;
  /** 难度 1–10 */
  difficulty: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** 可提取度：距上次复习 t 天、稳定性 S 时还记得的概率 */
export function fsrsRetrievability(elapsedDays: number, stability: number): number {
  const s = Math.max(stability, 0.01);
  return Math.pow(1 + (FACTOR * Math.max(elapsedDays, 0)) / s, DECAY);
}

/** 由稳定性反推间隔（天，≥1 的整数，封顶 `FSRS_MAX_INTERVAL`） */
export function fsrsInterval(stability: number, retention = FSRS_TARGET_RETENTION): number {
  const raw = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return clamp(Math.round(raw), 1, FSRS_MAX_INTERVAL);
}

function initDifficulty(g: FsrsGrade, w: readonly number[]): number {
  return clamp(w[4]! - Math.exp(w[5]! * (g - 1)) + 1, 1, 10);
}

/** 第一次复习（此前没有 FSRS 状态）后的状态 */
export function fsrsInit(g: FsrsGrade, w: readonly number[] = FSRS_DEFAULT_W): FsrsState {
  return { stability: Math.max(w[g - 1]!, 0.1), difficulty: initDifficulty(g, w) };
}

/**
 * 一次复习后的新状态。
 * @param elapsedDays 距上次复习的天数（同日重复为 0）
 */
export function fsrsNext(prev: FsrsState, g: FsrsGrade, elapsedDays: number, w: readonly number[] = FSRS_DEFAULT_W): FsrsState {
  const { stability: S, difficulty: D } = prev;
  const R = fsrsRetrievability(elapsedDays, S);
  // 难度：按评分偏移，线性阻尼（越接近 10 越难再涨），再向「轻松」初值均值回归
  const delta = -w[6]! * (g - 3);
  const damped = D + (delta * (10 - D)) / 9;
  const difficulty = clamp(w[7]! * initDifficulty(4, w) + (1 - w[7]!) * damped, 1, 10);
  let stability: number;
  if (g === 1) {
    const forget = w[11]! * Math.pow(D, -w[12]!) * (Math.pow(S + 1, w[13]!) - 1) * Math.exp(w[14]! * (1 - R));
    // 忘了之后的稳定性不能比忘之前还高
    stability = Math.min(forget, S);
  } else {
    const hard = g === 2 ? w[15]! : 1;
    const easy = g === 4 ? w[16]! : 1;
    const growth = Math.exp(w[8]!) * (11 - D) * Math.pow(S, -w[9]!) * (Math.exp(w[10]! * (1 - R)) - 1) * hard * easy;
    stability = S * (growth + 1);
  }
  return { stability: clamp(stability, 0.1, 36500), difficulty };
}

/**
 * 旧数据迁入：没有 FSRS 状态、但走过若干阶段的词条，用旧间隔当稳定性的近似起点。
 * ★ 旧曲线在到期日的保持率是 0.7（`DUE_RETENTION`），FSRS 的 S 定义在 0.9 ⇒ 按曲线换算：
 *   R(I, S)=0.7 ⇒ S = I·FACTOR / (0.7^(1/DECAY) − 1)。难度取中位 5。
 */
export function fsrsFromLegacy(intervalDays: number): FsrsState {
  const stability = (Math.max(intervalDays, 1) * FACTOR) / (Math.pow(0.7, 1 / DECAY) - 1);
  return { stability, difficulty: 5 };
}

/** 布尔「记住/忘了」→ 评分（旧打卡接口只有两个按钮） */
export function gradeFromRemembered(remembered: boolean): FsrsGrade {
  return remembered ? 3 : 1;
}

export function isFsrsGrade(x: unknown): x is FsrsGrade {
  return x === 1 || x === 2 || x === 3 || x === 4;
}
