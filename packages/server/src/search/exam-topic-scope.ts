/** 出题主题与用户已选范围相交：高考题先找高考题源，Java 题先找技术题源。 */
import { examHostAllowed } from '@sb/shared';
import type { ExamContext } from '../learning/exam-mode.js';

export function quizTopicScope(exam: ExamContext, query: string): ExamContext {
  const pack = /高考|高中|高[一二三]/.test(query) ? 'gaokao'
    : /中考|初中|初[一二三]/.test(query) ? 'zhongkao'
      : /考研/.test(query) ? 'kaoyan'
        : /四六级|四级|六级|\bCET\b/i.test(query) ? 'cet'
          : /公务员|国考|省考|事业单位/.test(query) ? 'gongkao'
            : /\b(?:java|python|golang|go|hashmap|redis|sql)\b|\bc\+\+(?!\w)|后端|全栈|线程池|前端|编程/i.test(query) ? 'tech-interview'
              : null;
  if (!pack || !exam.on) return exam;
  const custom = exam.customHosts ?? exam.hosts.filter((host) => !exam.sources.some((s) => examHostAllowed(host, [s.host])));
  const sources = exam.sources.filter((s) => examHostAllowed(s.host, exam.hosts)
    && (s.packs.includes(pack) || examHostAllowed(s.host, custom)));
  // 始终取原范围的子集；用户自填站即使有其它考试的登记元数据也不能吞掉。
  const hosts = exam.hosts.filter((host) => examHostAllowed(host, custom) || sources.some((s) => examHostAllowed(host, [s.host])));
  return { ...exam, sources, hosts };
}
