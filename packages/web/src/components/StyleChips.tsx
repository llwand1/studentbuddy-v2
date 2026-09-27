/**
 * StyleChips — 四维回答方式偏好的 chip 行（设置卡与出题前的选项卡共用一套渲染）。
 * 题面、选项文案全部来自 @sb/shared 的 ANSWER_STYLE_FIELDS：前端不复制一份，防漂移。
 * hint 进 chip 的 title 与题面右侧的灰字，不占 chip 宽度（样式与本件同目录，不依赖调用方的 css）。
 */
import { ANSWER_STYLE_FIELDS } from '@sb/shared';
import type { AnswerStyle } from '@sb/shared';
import './style-chips.css';

export function StyleChips({
  value,
  onChange,
  disabled,
}: {
  value: AnswerStyle;
  onChange: (next: AnswerStyle) => void;
  disabled?: boolean;
}) {
  return (
    <div className="style-rows">
      {ANSWER_STYLE_FIELDS.map((field) => {
        const picked = field.options.find((o) => o.value === value[field.key]);
        return (
          <div key={field.key} className="style-row">
            <div className="style-row-q">
              {field.question}
              {picked?.hint ? <span className="style-row-hint">{picked.hint}</span> : null}
            </div>
            <div className="style-row-chips">
              {field.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  title={o.hint}
                  className={o.value === value[field.key] ? 'style-chip active' : 'style-chip'}
                  disabled={disabled}
                  onClick={() => onChange(Object.assign({ ...value }, { [field.key]: o.value }))}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
