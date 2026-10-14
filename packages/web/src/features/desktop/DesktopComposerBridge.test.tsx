// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { DesktopComposerBridge } from './DesktopComposerBridge';
import { ComposerDock } from '../chat/ComposerDock';
import { CAPTURE_RESULT, discardDesktopCapture, HOST_QUICK_INPUT, parseDesktopCapture, receiveDesktopInput } from './desktop-input';
const image={id:'fixture-image',dataUrl:'data:image/png;base64,iVBORw0KGgo=',name:'截图.png',width:100,height:60};
function Harness({full=false}:{full?:boolean}){
  const [input,setInput]=useState('保留草稿'),[images,setImages]=useState<Array<{dataUrl:string;name?:string}>>(full?Array.from({length:4},()=>image):[]);
  const ref=useRef<HTMLTextAreaElement>(null);
  return <><DesktopComposerBridge input={input} setInput={setInput} inputRef={ref} attachments={images} setAttachments={setImages}/><ComposerDock busy={false} draft={!!input} onStop={()=>{}}><textarea aria-label="提问输入" ref={ref} value={input} onChange={e=>setInput(e.target.value)}/></ComposerDock><output aria-label="附件数量">{images.length}</output></>;
}
afterEach(()=>{cleanup();discardDesktopCapture();vi.restoreAllMocks();});
it('native screenshot is previewed locally, acceptance appends the draft without any request',()=>{
  const fetch=vi.spyOn(globalThis,'fetch');render(<Harness/>);
  act(()=>receiveDesktopInput(CAPTURE_RESULT+JSON.stringify(image)));
  expect(screen.getByRole('dialog',{name:'截图预览'})).toBeTruthy();expect(screen.getByRole('img').getAttribute('src')).toBe(image.dataUrl);
  fireEvent.change(screen.getByRole('textbox',{name:'截图问题'}),{target:{value:'解释这个报错'}});fireEvent.click(screen.getByRole('button',{name:'放入输入框'}));
  expect((screen.getByRole('textbox',{name:'提问输入'}) as HTMLTextAreaElement).value).toBe('保留草稿\n解释这个报错');expect(screen.getByLabelText('附件数量').textContent).toBe('1');expect(fetch).not.toHaveBeenCalled();
});
it('cancelling a screenshot preserves existing text and does not add an attachment',()=>{
  render(<Harness/>);act(()=>receiveDesktopInput(CAPTURE_RESULT+JSON.stringify(image)));fireEvent.click(screen.getByRole('button',{name:'取消'}));
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByLabelText('附件数量').textContent).toBe('0');expect((screen.getByRole('textbox',{name:'提问输入'}) as HTMLTextAreaElement).value).toBe('保留草稿');
});
it('quick input unfolds the existing composer instead of creating a conversation',()=>{
  render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'收起输入'}));
  act(()=>receiveDesktopInput(HOST_QUICK_INPUT));expect(screen.getByRole('button',{name:'收起输入'}).getAttribute('aria-expanded')).toBe('true');
});
it('full attachments cannot be exceeded by accepting screenshots',()=>{
  render(<Harness full/>);act(()=>receiveDesktopInput(CAPTURE_RESULT+JSON.stringify(image)));expect((screen.getByRole('button',{name:'放入输入框'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByLabelText('附件数量').textContent).toBe('4');
});
it('malformed captures are rejected visibly, remote URLs and invalid geometry are never accepted',()=>{
  expect(parseDesktopCapture(JSON.stringify({...image,dataUrl:'https://example.com/private.png'}))).toBeNull();expect(parseDesktopCapture(JSON.stringify({...image,width:-1}))).toBeNull();
  render(<Harness/>);act(()=>receiveDesktopInput(CAPTURE_RESULT+'invalid'));expect(screen.getByRole('alert').textContent).toContain('无效');expect(screen.queryByRole('img')).toBeNull();
});
it('a screenshot received before the composer mounts survives the ball-to-app transition',()=>{
  receiveDesktopInput(CAPTURE_RESULT+JSON.stringify(image));render(<Harness/>);expect(screen.getByRole('dialog',{name:'截图预览'})).toBeTruthy();
  fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
});
