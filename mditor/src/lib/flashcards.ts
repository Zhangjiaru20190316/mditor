// 闪卡调度（SM-2 简化版）与文档扫描的纯函数（模块 4，v4.7）。
//
// 调度模型（docs/research-features.md 为最终规范）：
//   * 间隔表 [0, 1, 3, 7, 14, 30] 天，按「盒子」box(0..5) 索引；
//   * 实际间隔 = table[box] × ease / 2.5（ease 起步 2.5，±0.15 微调，
//     下限 1.3）；
//   * 自评四档：忘了(0) → box=0、ease−0.15；困难(1) → box 不变、
//     ease−0.15；良好(2) → box+1；轻松(3) → box+1、ease+0.15；
//   * box 封顶 5（30 天 × ease 系数为最长日常间隔）。
//
// 卡片身份 = 文件路径 + 内容哈希（问题\0答案 的 FNV-1a）。文件改动后哈希
// 失配的进度标记「需重定位」（UI 提示，不自动迁移）。
//
// 全部纯函数（无 IO）；appDataDir 读写盘由 lib/reviewStore.ts 编排。

/** 四档自评。 */
export type ReviewGrade = 0 | 1 | 2 | 3; // 忘了 / 困难 / 良好 / 轻松

export const GRADE_LABELS: Record<ReviewGrade, string> = {
  0: "忘了",
  1: "困难",
  2: "良好",
  3: "轻松",
};

/** 间隔表（天）。 */
export const INTERVAL_TABLE = [0, 1, 3, 7, 14, 30] as const;

export const START_EASE = 2.5;
export const MIN_EASE = 1.3;
export const EASE_STEP = 0.15;
export const MAX_BOX = 5;

/** 一张卡的调度状态（持久化于 review-state.json）。 */
export interface CardSchedule {
  /** 距 epoch 的天数（本地时区）。 */
  dueDay: number;
  box: number;
  ease: number;
  /** 上次复习的 epoch 毫秒。 */
  lastReview: number;
  /** 创建/首次扫描的 epoch 毫秒。 */
  addedAt: number;
  /** 累计复习次数。 */
  reviews: number;
  /** 连续「忘了」次数（>=3 时 UI 可建议删卡）。 */
  lapses: number;
}

/** 新卡初始状态：当天到期。 */
export function newSchedule(now = Date.now()): CardSchedule {
  return {
    dueDay: dayOf(now),
    box: 0,
    ease: START_EASE,
    lastReview: 0,
    addedAt: now,
    reviews: 0,
    lapses: 0,
  };
}

/** epoch 毫秒 → 本地日序号（按本地时区的自然日切分）。 */
export function dayOf(epochMs: number): number {
  const d = new Date(epochMs);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000
  );
}

/** 计算实际间隔（天，向下取整；忘了=0 当天再现）。 */
export function intervalDays(box: number, ease: number): number {
  const idx = Math.min(Math.max(box, 0), MAX_BOX);
  return Math.floor((INTERVAL_TABLE[idx] * ease) / START_EASE);
}

/**
 * 自评后推进调度（纯函数）。
 *   forgot(0)：box 归零、ease −0.15（下限 1.3）、当天到期（重学）；
 *   hard(1)：box 不变、ease −0.15；
 *   good(2)：box +1；
 *   easy(3)：box +1、ease +0.15。
 */
export function scheduleAfter(
  prev: CardSchedule,
  grade: ReviewGrade,
  now = Date.now()
): CardSchedule {
  let { box, ease } = prev;
  let lapses = prev.lapses;
  if (grade === 0) {
    box = 0;
    ease = Math.max(MIN_EASE, ease - EASE_STEP);
    lapses += 1;
  } else if (grade === 1) {
    ease = Math.max(MIN_EASE, ease - EASE_STEP);
  } else if (grade === 3) {
    box = Math.min(MAX_BOX, box + 1);
    ease = ease + EASE_STEP;
  } else {
    box = Math.min(MAX_BOX, box + 1);
  }
  const days = grade === 0 ? 0 : Math.max(1, intervalDays(box, ease));
  return {
    dueDay: dayOf(now) + days,
    box,
    ease: Math.round(ease * 100) / 100,
    lastReview: now,
    addedAt: prev.addedAt,
    reviews: prev.reviews + 1,
    lapses,
  };
}

/** 卡是否今天到期（含逾期）。 */
export function isDue(s: CardSchedule, now = Date.now()): boolean {
  return s.dueDay <= dayOf(now);
}

// ---- 文档扫描（行扫描，与 vaultIndex 同纪律：不走 remark） --------------------

/** 扫描出的一张卡。 */
export interface ScannedCard {
  /** 所属文件路径（扫描时注入）。 */
  path: string;
  /** `:::flash` 起始行（0-based）。 */
  line: number;
  question: string;
  answer: string;
  /** question\0answer 的 FNV-1a（卡片身份）。 */
  hash: string;
}

/** FNV-1a 32 位哈希（卡片身份用，非密码学）。 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function cardHash(question: string, answer: string): string {
  return fnv1a(`${question}\u0000${answer}`);
}

/**
 * 单文档闪卡扫描：识别 `:::flash … --- … :::` 容器。
 * 代码围栏（``` / ~~~）内的 :::flash 不识别；未闭合的容器整体跳过。
 * 问题 = 首个 `---` 之前的文本（拼行）；答案 = 其后文本。
 */
export function scanFlashcards(content: string, path = ""): ScannedCard[] {
  const cards: ScannedCard[] = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceMark = "";
  let i = 0;
  const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      const mark = fence[1][0].repeat(3);
      if (!inFence) {
        inFence = true;
        fenceMark = mark;
      } else if (line.trim().startsWith(fenceMark)) {
        inFence = false;
        fenceMark = "";
      }
      i++;
      continue;
    }
    if (inFence) {
      i++;
      continue;
    }
    if (/^:::flash\s*$/.test(line.trim())) {
      // 找闭合 :::（忽略围栏——上面已串行跳过）。
      let j = i + 1;
      let closed = -1;
      while (j < lines.length) {
        if (/^:::\s*$/.test(lines[j].trim())) {
          closed = j;
          break;
        }
        j++;
      }
      if (closed < 0) break; // 未闭合：容器无效，停止
      const inner = lines.slice(i + 1, closed);
      const sepIdx = inner.findIndex((l) => /^-{3,}\s*$/.test(l.trim()));
      const question = (sepIdx >= 0 ? inner.slice(0, sepIdx) : inner)
        .join(" ")
        .trim();
      const answer =
        sepIdx >= 0 ? inner.slice(sepIdx + 1).join(" ").trim() : "";
      if (question || answer) {
        cards.push({
          path,
          line: i,
          question,
          answer,
          hash: cardHash(question, answer),
        });
      }
      i = closed + 1;
      continue;
    }
    i++;
  }
  return cards;
}

/** 生成一张闪卡的 Markdown 源文本（做卡入口插入用）。 */
export function flashcardMarkdown(question: string, answer: string): string {
  return `:::flash\n${question.trim()}\n---\n${answer.trim()}\n:::`;
}
