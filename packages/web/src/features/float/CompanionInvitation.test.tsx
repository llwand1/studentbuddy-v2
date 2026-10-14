// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CompanionInvitation } from './CompanionInvitation';
const opener={id:'q1',scope:'',question:{topic:'闭包',question:'题干',options:['A','B'],answer:0,explanation:'解析'}};
afterEach(()=>{cleanup();delete(window as unknown as {chrome?:unknown}).chrome;});
it('a browser preview has complete accessible text, character effects and explicit challenge / snooze actions',()=>{
  const challenge=vi.fn(),snooze=vi.fn();render(<CompanionInvitation opener={opener} onChallenge={challenge} onSnooze={snooze}/>);
  expect(screen.getByText('闭包的小题出好了，快来挑战一下吧！')).toBeTruthy();expect(document.querySelectorAll('.sb-invite-char').length).toBeGreaterThan(15);
  expect(challenge).not.toHaveBeenCalled();fireEvent.click(screen.getByText('挑战一下'));expect(challenge).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('两分钟后'));expect(snooze).toHaveBeenCalledOnce();
});
it('sends one native invite per unchanged question, with no expansion, and cleans it on unmount',()=>{
  const sent:string[]=[];(window as unknown as {chrome:unknown}).chrome={webview:{postMessage:(message:string)=>sent.push(message)}};
  const view=render(<CompanionInvitation opener={opener} onChallenge={()=>{}} onSnooze={()=>{}}/>);
  view.rerender(<CompanionInvitation opener={{...opener}} onChallenge={()=>{}} onSnooze={()=>{}}/>);
  expect(sent).toHaveLength(1);expect(JSON.parse(sent[0]!.slice('sb-float:invite:'.length))).toEqual({id:'q1',topic:'闭包',reducedMotion:false});
  expect(screen.queryByText('挑战一下')).toBeNull();view.unmount();expect(sent.at(-1)).toBe('sb-float:invite:off');expect(sent).not.toContain('sb-float:quiz');
});
