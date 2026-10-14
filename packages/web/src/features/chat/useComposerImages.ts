import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { MAX_CHAT_IMAGES } from '@sb/shared';
import { judgeLoadedImage, intakeRejectHint, remainingSlots } from '../../lib/image-intake';
type Image = { dataUrl: string; name?: string };
/** FileReader intake is independent of layout and shared with the screenshot draft bridge. */
export function useComposerImages(attachments: Image[], setAttachments: Dispatch<SetStateAction<Image[]>>) {
  const fileRef = useRef<HTMLInputElement>(null);
  // Pending readers reserve slots: multiple pastes within one tick cannot exceed the shared cap.
  const inflight = useRef(0);
  const [intakeHint, setIntakeHint] = useState('');
  const addImages = (files: File[]) => {
    const room = remainingSlots(attachments.length, inflight.current);
    if (room <= 0) { setIntakeHint(intakeRejectHint('full', files.length)); return; }
    let skipped = 0;
    for (const file of files.filter(f=>f.type.startsWith('image/')).slice(0,room)) {
      inflight.current++; const reader = new FileReader();
      const release = () => { inflight.current--; };
      reader.onload = () => {
        release(); const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        const verdict = judgeLoadedImage(dataUrl,attachments.length);
        if (verdict !== 'accept') { skipped++; setIntakeHint(intakeRejectHint(verdict,skipped)); return; }
        setIntakeHint('');
        setAttachments(a=>a.length >= MAX_CHAT_IMAGES ? a : [...a,{dataUrl,name:file.name}]);
      };
      reader.onerror = release; reader.readAsDataURL(file);
    }
  };
  return { fileRef, intakeHint, addImages };
}
