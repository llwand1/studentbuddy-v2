/**
 * PkInviteCard — 「AI 主动发起对战」的邀请卡（契约 docs/PK-SPEC.md §16.9，2026-09-24 老板点单）。
 *
 * 形态与 `ChoiceCard` 同族：内联在输入框上方、**不 modal、不加遮罩**，样式复用 `choice.css`
 * 的卡壳基元（那张表已被 ConfirmCard 复用过一次，不再各写一套）。
 *
 * ★ 文案有一条是**硬要求**（§16.9）：必须写清「你出题、AI 也出题」——只说「来一局对战」，
 *   学习者会以为是自己去做一套题。这是本卡与选择框最大的语义差别，写错就是货不对板。
 * ★ 「不接受也没关系」必须当面说：邀请的压力感全来自「不点会不会得罪 AI」，这句是逃生口，
 *   也是 §16.7 那三条频率闸门在界面上的对应物。
 *
 * 图标一律自绘 SVG line-icon（本仓约定：不用 emoji、不引图标字体）。
 */
import { pkRoomHash, type PkInviteQueue } from './usePkInviteQueue';
import './choice.css';

/** 交叉双剑（对战）——自绘 line-icon，与 choice.css 的 22px 图标盒同尺寸 */
const ICON_SWORDS = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3h1.6l7 7v1.6L10 13 3 6V3z" />
    <path d="M13 3h-1.6l-2.2 2.2" />
    <path d="M3 13h1.6l2.2-2.2" />
    <path d="M9.4 9.4 13 13" />
  </svg>
);
const ICON_CHECK = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 6.5 4.6 9 10 3.5" />
  </svg>
);
const ICON_INFO = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="6" cy="6" r="4.5" />
    <path d="M6 4v2.4M6 8.2h.01" />
  </svg>
);

/**
 * 吃整个 queue 而不是散装 props：`ChatView` 已贴 300 行红线，挂线处必须只留一行
 * （`{pkInvite.invite && <PkInviteCard queue={pkInvite} />}`）——本仓「贴线就拆文件」的老规矩。
 */
export function PkInviteCard({ queue }: { queue: PkInviteQueue }) {
  const { invite, inviteBusy: busy, acceptInvite, rejectInvite, dismissInvite } = queue;
  if (!invite) return null;
  const pending = invite.status === 'pending';
  const accepted = invite.status === 'accepted';

  return (
    <div className={`choice-card pk-invite${pending ? '' : ' settled'}`}>
      <div className="choice-head">
        <span className={`choice-ico${pending ? '' : ' ok'}`}>{pending ? ICON_SWORDS : ICON_CHECK}</span>
        <span className="choice-title">{pending ? 'AI 邀请你打一局对战' : accepted ? '对战已开始' : '这局不打了'}</span>
        {pending && <span className="choice-state">8 分钟 · 人机同口径</span>}
      </div>

      <div className="choice-q">
        <span className="pk-invite-topic">{invite.topic}</span>
        {invite.reason && <span className="pk-invite-reason">{invite.reason}</span>}
      </div>

      {pending ? (
        <>
          <div className="confirm-btns">
            <button type="button" className="confirm-btn ok" disabled={busy} onClick={() => void acceptInvite()}>
              {busy ? '正在开局…' : '接受，去出题'}
            </button>
            <button type="button" className="confirm-btn bad" disabled={busy} onClick={rejectInvite}>
              这次不用
            </button>
          </div>
          <div className="choice-foot">
            {ICON_INFO}
            <span>
              规则是<strong>你出一题让 AI 答、AI 出一题让你答</strong>，谁答对谁得分；接受后会跳到对战页。
              不想打就点「这次不用」，或者直接不理——AI 会继续讲，不会等你。
            </span>
          </div>
        </>
      ) : (
        <div className="choice-done-row">
          <span>
            {accepted
              ? '已按你们刚才的主题开局了。'
              : '已拒绝，AI 不会开始对战（想打可以随时再让它邀请一局）。'}
          </span>
          {/* 别处点的接受：本端没跳转，给一条进场的路；库里 room_id 指不到内存房时不显示（点了也是 404） */}
          {accepted && invite.roomId ? (
            <a className="choice-dismiss" href={pkRoomHash(invite.roomId)}>
              进入对局
            </a>
          ) : (
            <button type="button" className="choice-dismiss" onClick={dismissInvite}>
              收起
            </button>
          )}
        </div>
      )}
    </div>
  );
}
