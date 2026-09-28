/**
 * ChatSpeaker —— 消息头：像素头像 + 铭牌（2026-09-28 对话页换装「篝火对谈」）。
 *
 * 对话页此前是全站唯一还长着「默认聊天软件」模样的页面：无头像、无铭牌，气泡与其它页面的黑铁金线面板
 * 不是一套语言。这里把说话者做成与大陆 HUD / 卡牌页同款的**铭牌**：
 *   · 助手＝见习法师团子（复用 `Mascot`，品牌吉祥物，配色随 --sb-primary）；
 *   · 用户＝勇者（复用 `hero-sprites.ts` 的 HERO_MAP——落地页序章、知识大陆里走位的就是它）。
 * `live`＝这条正在吟唱（等待态 / 流式中）：头像框亮金线、团子按节拍跳、余烬上飘——全在 CSS，
 * 这里只翻一个 class。样式见 `styles/grimoire-chat.css`。
 * 团子每枚都是真节点（它自带眨眼动画，得各眨各的，40 个 rect 可以接受）；勇者是静态点阵，走 <symbol>/<use> 共用一份。
 * 铭牌文字对辅助技术可读（谁在说话是有用信息），头像与英文角标是装饰（aria-hidden）。
 */
import { Mascot } from './Mascot';
import { PixelSpriteDefs, PixelSpriteUse } from '../../components/PixelSprite';
import { HERO_MAP, HERO_PAL } from '../../app/hero/hero-sprites';

export type SpeakerRole = 'assistant' | 'user';

/** 勇者点阵的 symbol id：`ChatSpeakerDefs` 定义一次，每枚用户铭牌只 `<use>` 它（104 个 rect 不跟着消息数翻倍） */
export const HERO_SPRITE_ID = 'ch-hero-sprite';

/** 放在对话视图根下一次（ChatView）；铭牌本身不带定义——带了就每条消息一份，白合并了 */
export function ChatSpeakerDefs() {
  return <PixelSpriteDefs id={HERO_SPRITE_ID} map={HERO_MAP} pal={HERO_PAL} />;
}

export const SPEAKER_LABEL: Record<SpeakerRole, { name: string; tag: string }> = {
  assistant: { name: '团子', tag: 'BUDDY' },
  user: { name: '你', tag: 'HERO' },
};

export function ChatSpeaker({ role, live = false }: { role: SpeakerRole; live?: boolean }) {
  const label = SPEAKER_LABEL[role];
  return (
    <div className={`chat-speaker ${role}${live ? ' live' : ''}`}>
      <span className="chat-speaker-avatar">
        {role === 'assistant' ? <Mascot /> : <PixelSpriteUse id={HERO_SPRITE_ID} className="chat-hero-px" />}
      </span>
      <span className="chat-speaker-name">{label.name}</span>
      <span className="chat-speaker-tag" aria-hidden="true">
        {label.tag}
      </span>
      {live && (
        <span className="chat-speaker-live" aria-hidden="true">
          吟唱中
        </span>
      )}
    </div>
  );
}
