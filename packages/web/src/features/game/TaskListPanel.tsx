/**
 * TaskListPanel — 任务清单（原「学习督促」，契约 `docs/TERM-CARDS-SPEC.md` §5）。
 *
 * ★★ **「我做完了」这枚钮不判完成**：它只催服务端重算一次（`tasks.ts:completeTask`）。
 *   完成的口径是库里的事实（★n 要 `2^n` 张卡、当天有没有复习过、那条候选裁决过没有），
 *   只有服务端能算。若这枚钮直接置 done 并本地发钥匙，任何人发一个 POST 就能刷满宝箱
 *   ——所以不满足时后端返 `not_yet`，这里**如实显示"条件还没到位"**，而不是假装成功。
 * ★ 补池单的按钮是**两枚**（通过／否掉），不是一枚「同意」：那一单要的动作是**裁决**，
 *   驳回同样把池子管起来了，不裁决才是问题（§5 那条 ★ 判据）。UI 上把它们做成一对对称的
 *   钮，而不是"接受 + 一个不起眼的叉"——形状本身在说"两个方向都算数"。
 * ★ 待审候选一律标「AI 生成，待人工校对」：词池是抽卡的**唯一来源**，一条幻觉释义进了池子
 *   就会被当成"新词"发给用户。人工闸门是这个玩法能开盒的前提，不是流程装饰（§4）。
 * ⚠️ 新单的 `entering` 错帧只在**这一批 id** 上挂：类名来自 `freshTaskIds`（SSE 那一帧带来的
 *   id 列表），不是"渲染就播"——否则每次切回本页整列都在跳舞，T1 的频次判据当场违约。
 */
import { useState } from 'react';
import { api, type PoolCandidate, type StudyTask } from '../../lib/api';
import { TaskIcon, SparkleIcon } from '../../components/game-icons';
// 勾是**通用符号**，`icons.tsx` 已有一份 ⇒ 复用，不在游戏集里重画第二条（两份同形状＝双写，
// 改一个的另一份就露馅）。`game-icons.tsx` 收的是宝箱／钥匙／星这类**游戏物件**。
import { CheckIcon } from '../../components/icons';
import '../../styles/game.css';
import './cards-view.css';

const KIND_LABEL: Record<StudyTask['kind'], string> = {
  advance: '推进',
  unstall: '破停滞',
  review_pool: '补池',
};

interface Banner {
  kind: 'ok' | 'bad' | 'info';
  title: string;
  body: string;
}

export function TaskListPanel({
  tasks,
  candidates,
  freshTaskIds,
  onChanged,
}: {
  tasks: StudyTask[];
  candidates: PoolCandidate[];
  freshTaskIds: string[];
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState('');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [hideDone, setHideDone] = useState(true);

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  const complete = async (t: StudyTask) => {
    setBusyId(t.id);
    try {
      const r = await api.cards.completeTask(t.id);
      setBanner({
        kind: r.keyGranted ? 'ok' : 'info',
        title: r.keyGranted ? '这单结了，+1 把钥匙' : '这单早就结了',
        body: r.keyGranted
          ? '攒够就能多开一次宝箱（今天开满 8 次为止）。'
          : '库里它的状态已是完成，钥匙在第一次翻转时发过了。',
      });
    } catch (e) {
      // `not_yet` 是这一路最常见、也最该说清的结果：**不是失败，是还没到**
      setBanner({
        kind: 'bad',
        title: '条件还没到位',
        body: e instanceof Error && e.message ? e.message : '这一单的完成条件由服务端算，差一点都点不动。',
      });
    } finally {
      setBusyId('');
      onChanged();
    }
  };

  const decide = async (c: PoolCandidate, approved: boolean) => {
    setBusyId(c.id);
    try {
      const r = await api.cards.decideCandidate(c.id, approved);
      setBanner({
        kind: 'ok',
        title: approved ? `「${c.term}」进池了` : `「${c.term}」已否掉`,
        body: r.keysGranted > 0 ? '裁决就是这一单的完成动作，+1 把钥匙。' : '裁决记下了；这一单的钥匙此前已发过。',
      });
    } catch (e) {
      setBanner({ kind: 'bad', title: '裁决没落库', body: e instanceof Error ? e.message : '请刷新后重试' });
    } finally {
      setBusyId('');
      onChanged();
    }
  };

  return (
    <section className="cv-tasks">
      <div className="cv-wall-head">
        <div className="cv-wall-title">
          <span className="gm-eyebrow">Quests</span>
          <h2 className="cv-h2">
            <TaskIcon size={24} /> 任务清单 {open.length} 单待办
          </h2>
        </div>
        {done.length > 0 && (
          <button type="button" className="gm-btn gm-ghost gm-sm" onClick={() => setHideDone((v) => !v)}>
            {hideDone ? `已完成 ${done.length}` : '收起已完成'}
          </button>
        )}
      </div>

      {banner && (
        <div className={`gm-banner${banner.kind === 'bad' ? ' gm-bad' : banner.kind === 'info' ? ' gm-info' : ''}`} role="status">
          <SparkleIcon size={24} />
          <div>
            <b>{banner.title}</b>
            <span>{banner.body}</span>
          </div>
        </div>
      )}

      {open.length === 0 && (
        <p className="cv-empty">
          <TaskIcon size={24} /> 现在没有待办单。清单每几小时自动重排一次——进度够了、有词凉下来了、或宝箱快空了，都会派新单进来。
        </p>
      )}

      <div className="cv-task-list">
        {open.map((t) => (
          <article
            key={t.id}
            className={`gm-task gm-open${freshTaskIds.includes(t.id) ? ' entering' : ''}`}
          >
            <button
              type="button"
              className="cv-check-btn"
              aria-label={`标记完成：${t.title}`}
              disabled={busyId === t.id}
              onClick={() => void complete(t)}
            >
              <span className="gm-check">
                <CheckIcon size={15} />
              </span>
            </button>
            <div className="cv-task-main">
              <h3 className="gm-task-title">
                {t.title}
                <span className="cv-task-kind">{KIND_LABEL[t.kind]}</span>
              </h3>
              <p className="gm-task-why">{t.why}</p>
            </div>
            <div className="cv-task-actions">
              <button
                type="button"
                className={`gm-btn gm-sm${busyId === t.id ? ' cv-busy' : ''}`}
                disabled={busyId === t.id}
                onClick={() => void complete(t)}
              >
                {busyId === t.id ? '判定中…' : '我做完了'}
              </button>
            </div>
          </article>
        ))}

        {/* 补池单的行下面直接把待审候选摆出来：裁决动作和那一单在同一屏，不让用户跳去设置页找 */}
        {candidates.map((c) => (
          <div key={c.id} className="cv-cand">
            <div className="cv-task-main">
              <h3 className="gm-task-title">「{c.term}」</h3>
              <p className="cv-cand-def">{c.definition}</p>
              <p className="gm-task-why">
                领域：{c.domain}
                {c.aliases.length > 0 ? ` · 别名 ${c.aliases.length} 个` : ''}
              </p>
              <span className="cv-cand-flag">
                <SparkleIcon size={16} /> AI 生成，待人工校对
              </span>
            </div>
            <div className="cv-task-actions">
              <button
                type="button"
                className={`gm-btn gm-ok gm-sm${busyId === c.id ? ' cv-busy' : ''}`}
                disabled={busyId === c.id}
                onClick={() => void decide(c, true)}
              >
                通过
              </button>
              <button
                type="button"
                className={`gm-btn gm-ghost gm-sm${busyId === c.id ? ' cv-busy' : ''}`}
                disabled={busyId === c.id}
                onClick={() => void decide(c, false)}
              >
                否掉
              </button>
            </div>
          </div>
        ))}

        {!hideDone &&
          done.map((t) => (
            <article key={t.id} className="gm-task gm-done">
              <span className="gm-check">
                <CheckIcon size={15} />
              </span>
              <div className="cv-task-main">
                <h3 className="gm-task-title">{t.title}</h3>
                <p className="gm-task-why">{t.why}</p>
              </div>
            </article>
          ))}
      </div>
    </section>
  );
}
