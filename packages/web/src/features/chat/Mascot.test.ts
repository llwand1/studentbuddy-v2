import { describe, expect, it } from 'vitest';
import { CLS, LID, SPRITE, spriteErrors } from './Mascot';

describe('像素团子点阵', () => {
  it('点阵与类名映射自洽，合帧不压错格', () => {
    expect(spriteErrors()).toEqual([]);
  });

  it('16×16 齐边，且用到的档位齐（亮/本体/暗/墨/眼神光）', () => {
    expect(SPRITE).toHaveLength(16);
    expect(LID).toHaveLength(2);
    const used = new Set(SPRITE.join('').split('').filter((c) => c !== '.'));
    expect([...used].sort().join('')).toBe('BELMSWo');
    expect(new Set(Object.values(CLS)).size).toBe(5);
  });

  it('眨眼只是把眼位换成一条墨线，不改身体轮廓', () => {
    const [lidTop = '', lidBottom = ''] = LID;
    const lidInk = lidBottom.split('').filter((c) => c === 'o').length;
    const lidBody = lidTop.split('').filter((c) => c === 'B').length;
    expect(lidInk).toBe(4);
    expect(lidBody).toBe(4);
    expect(LID.join('').replace(/\./g, '')).toHaveLength(8);
  });
});
