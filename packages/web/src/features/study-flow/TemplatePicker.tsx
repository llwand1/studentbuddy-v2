/**
 * TemplatePicker — 新建学习流时的**模板选择**（契约 docs/STUDY-FLOW-SPEC.md §2.3）。
 *
 * ★ 参考 Dify 的「从模板创建」：新建的第一步是挑一份已经配好的模板，而不是进一个空白编辑器。
 *   模板卡片上给三样东西——**叫什么、干什么、为什么这么连**。第三样最要紧：
 *   用户第一次见到「答对 / 答错」两个出口时，需要有人告诉他这有什么用，
 *   否则那三个下拉框对他来说只是三个看不懂的控件。
 *
 * ★ 不在这里做「预览整张图」：画布本身就是最好的预览，多一层预览图只会多一处要维护的渲染。
 *   选定后立刻落在画布上，不喜欢就删掉重选——克隆/删除都是现成的。
 */
import { FLOW_TEMPLATES } from './flow-templates';

export function TemplatePicker({
  busy,
  onPick,
  onClose,
}: {
  busy: boolean;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fl-tpl">
      <div className="fl-tpl-head">
        <span>从模板开始</span>
        <button className="fl-mini" onClick={onClose}>
          收起
        </button>
      </div>
      <p className="fl-panel-hint">
        模板已经把步骤、参数示例和连线配好了，新建出来就能直接跑；跑通之后再按自己的主题改。
      </p>
      <div className="fl-tpl-list">
        {FLOW_TEMPLATES.map((t) => (
          <button key={t.key} className="fl-tpl-item" disabled={busy} onClick={() => onPick(t.key)}>
            <span className="fl-tpl-name">
              {t.name}
              {t.recommended && <em className="fl-tpl-rec">推荐</em>}
              <em className="fl-tpl-steps">{t.steps.length} 步</em>
            </span>
            <span className="fl-tpl-summary">{t.summary}</span>
            <span className="fl-tpl-why">{t.why}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
