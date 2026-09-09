/**
 * chat-export —— 导出内容生成的回归。下载触发（DOM）不可测，所以生成与触发必须拆开：
 * 这份测试锁的是「导出物是干净可用的 Markdown」这一件事。
 */
import { describe, expect, it } from 'vitest';
import { buildExportMarkdown, exportFilename, formatFullTime, sanitizeFilename } from './chat-export';

describe('formatFullTime（导出用完整时间）', () => {
  it('SQLite UTC 串按 UTC 解析后落成本地时刻（东八区 +8）', () => {
    expect(formatFullTime('2026-09-09 07:52:03')).toBe('2026-09-09 15:52');
  });

  it('空值与非法串返回空串，不把 Invalid Date 写进导出文件', () => {
    expect(formatFullTime(undefined)).toBe('');
    expect(formatFullTime('不是时间')).toBe('');
  });
});

describe('buildExportMarkdown（导出内容）', () => {
  it('标题、导出时间、逐条角色与时间齐备，正文原样嵌入', () => {
    const md = buildExportMarkdown(
      '电磁学复习',
      [
        { role: 'user', content: '什么是楞次定律', ts: '2026-09-09 07:52:03' },
        { role: 'assistant', content: '感应电流的效果总是**阻碍**磁通变化。', ts: '2026-09-09 07:52:30' },
      ],
      new Date('2026-09-09T08:45:00Z'),
    );
    expect(md).toContain('# 电磁学复习');
    expect(md).toContain('## 我');
    expect(md).toContain('## 助手');
    expect(md).toContain('什么是楞次定律');
    expect(md).toContain('**阻碍**磁通变化'); // markdown 原文不被转义、不进代码围栏
    expect(md).not.toContain('```'); // 不给正文套代码围栏
  });

  it('空内容的消息不产出空段落（历史里 quiz 卡之类 content 为空的行不该进导出）', () => {
    const md = buildExportMarkdown('t', [
      { role: 'assistant', content: '' },
      { role: 'user', content: 'hi' },
    ]);
    expect(md).not.toContain('## 助手');
    expect(md).toContain('## 我');
  });

  it('空标题回落为「对话」，不产出 "#  " 这种空标题行', () => {
    const md = buildExportMarkdown('   ', []);
    expect(md).toContain('# 对话');
  });

  it('无时间戳的消息不带空括号', () => {
    const md = buildExportMarkdown('t', [{ role: 'user', content: 'hi' }]);
    expect(md).toMatch(/## 我\n/); // 标题行后直接空行，没有（）
    expect(md).not.toContain('（）');
  });
});

describe('sanitizeFilename 与 exportFilename', () => {
  it('Windows 保留字符换成下划线，空名回落「对话」', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFilename('   ')).toBe('对话');
  });

  it('导出文件名 = 净化标题 + 导出日期', () => {
    expect(exportFilename('电磁学复习', new Date('2026-09-09T08:45:00Z'))).toMatch(/^电磁学复习-\d{8}\.md$/);
  });
});
