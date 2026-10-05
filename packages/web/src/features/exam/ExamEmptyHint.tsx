/**
 * ExamEmptyHint — 应试模式下的空态与引导（老板 2026-10-05 拍：空态页＋引导，不是退回全库）。
 *
 * 为什么必须有它：范围过滤发生在服务端，页面拿到的空列表**不解释自己为什么空**。
 * 老库里的词条在升级后普遍没有来源记录（`term_source` 是新表），于是"开一下模式"就会让
 * 词条页／知识大陆／卡墙同时变空——用户读到的是"我的数据被删了"。这一句把它说成事实：
 * **数据没丢，是范围从这一轮之后才开始记来源**。
 *
 * ★ 三态分开写：开着但没勾范围／勾了范围内没词／关着（关着时本组件不渲染，走各页原空态）。
 *   合并成一句"这里还没有内容"就是假空态——那会让人去点一个不该点的按钮。
 */
import { useExamScope } from './useExamScope';
import './exam.css';

/** 这一面上具体是什么东西（`词条`／`地块与怪`／`卡`），只用于把话说完整，不参与判定 */
export function ExamEmptyHint({ what, onGoSettings }: { what: string; onGoSettings?: () => void }) {
  const scope = useExamScope();
  if (!scope.on) return null;

  const go = onGoSettings ?? (() => undefined);
  if (scope.hosts === 0) {
    return (
      <div className="exam-empty">
        <p className="exam-empty-title">应试模式开着，但你还没选范围</p>
        <p className="exam-empty-note">
          没选范围时外部检索是关着的（不会去网上取资料），已有的{what}照常显示。
          去设置里勾一个考试类目，范围才开始生效。
        </p>
        {onGoSettings && (
          <button className="exam-empty-btn" onClick={go}>
            去设置选范围
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="exam-empty">
      <p className="exam-empty-title">你选的范围内还没有{what}</p>
      <p className="exam-empty-note">
        当前范围＝{scope.summary || '未选'}。范围只认<b>来源站在范围内</b>的内容：
        从这些站里出题、读网页并存成词条之后，{what}才会在这里长出来。
        范围外的内容没有丢，只是这一档不显示——把范围放宽或关掉应试模式就能看到。
      </p>
      {scope.directSites.length > 0 && (
        <p className="exam-empty-note">范围内可以直接取题的站：{scope.directSites.join('、')}。</p>
      )}
      {onGoSettings && (
        <button className="exam-empty-btn" onClick={go}>
          去设置调整范围
        </button>
      )}
    </div>
  );
}
