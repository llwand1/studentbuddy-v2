/** 对战关键事件的轻量像素反馈；装饰层不承载判分信息，也不拦截操作。 */
export type PkBattleFxKind = 'question' | 'correct' | 'wrong' | 'timeout' | 'combo';

export interface PkBattleFxState {
  kind: PkBattleFxKind;
  key: number;
  combo?: number;
}

const LABEL: Record<PkBattleFxKind, string> = {
  question: '新题到场',
  correct: '命中',
  wrong: '失误',
  timeout: '时间到',
  combo: '连击',
};

export function PkBattleFx({ fx }: { fx: PkBattleFxState | null }) {
  if (!fx) return null;
  return (
    <div className={`sb-pk-battle-fx ${fx.kind}`} key={fx.key} aria-hidden="true">
      <i /><i /><i /><i />
      <b>{fx.kind === 'combo' ? `连击 ×${fx.combo ?? 0}` : LABEL[fx.kind]}</b>
    </div>
  );
}
