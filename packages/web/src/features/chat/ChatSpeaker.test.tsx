// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChatSpeaker, SPEAKER_LABEL } from './ChatSpeaker';

afterEach(cleanup);

describe('<ChatSpeaker>', () => {
  it('names the assistant 团子 with the mascot avatar and the BUDDY tag', () => {
    const { container } = render(<ChatSpeaker role="assistant" />);
    const root = container.querySelector('.chat-speaker');
    expect(root?.className).toBe('chat-speaker assistant');
    expect(root?.querySelector('.chat-speaker-name')?.textContent).toBe(SPEAKER_LABEL.assistant.name);
    expect(root?.querySelector('.chat-speaker-tag')?.textContent).toBe('BUDDY');
    expect(root?.querySelector('.chat-speaker-avatar .welcome-mascot')).not.toBeNull();
    expect(root?.querySelector('.chat-hero-px')).toBeNull();
  });
  it('names the user 你 with the shared hero sprite and the HERO tag', () => {
    const { container } = render(<ChatSpeaker role="user" />);
    const root = container.querySelector('.chat-speaker');
    expect(root?.className).toBe('chat-speaker user');
    expect(root?.querySelector('.chat-speaker-name')?.textContent).toBe('你');
    expect(root?.querySelector('.chat-speaker-tag')?.textContent).toBe('HERO');
    expect(root?.querySelector('.chat-speaker-avatar svg.chat-hero-px')).not.toBeNull();
    expect(root?.querySelector('.welcome-mascot')).toBeNull();
  });
  it('keeps avatar and tags decorative: only the name is exposed to assistive tech', () => {
    const { container } = render(<ChatSpeaker role="assistant" live />);
    expect(container.querySelector('.chat-speaker-avatar .welcome-mascot')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.chat-speaker-tag')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.chat-speaker-live')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    expect(container.querySelector('[style]')).toBeNull();
  });
  it('flips only a class + a "吟唱中" marker for the live state and drops both when idle', () => {
    const live = render(<ChatSpeaker role="assistant" live />);
    expect(live.container.querySelector('.chat-speaker.live')).not.toBeNull();
    expect(live.container.querySelector('.chat-speaker-live')?.textContent).toBe('吟唱中');
    cleanup();
    const idle = render(<ChatSpeaker role="assistant" live={false} />);
    expect(idle.container.querySelector('.chat-speaker.live')).toBeNull();
    expect(idle.container.querySelector('.chat-speaker-live')).toBeNull();
  });
});
