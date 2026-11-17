export const GUIDES = Object.freeze({
  voiceover: {
    name: 'VoiceOver',
    intro: 'Here are the VoiceOver keys for exploring this image. While a choice is open, use Next, Repeat, or Back. Press Escape to leave this guide.',
    steps: [
      'VoiceOver uses Control plus Option by default; it may also be set to Caps Lock.',
      'Return to the page and press VO plus Command plus G for the next image, or VO plus Command plus Shift plus G for the previous image.',
      'Once you hear the target image, press VO plus Shift plus L to request a description.',
      'If there is no description, open VoiceOver Utility and enable image recognition in Recognition.',
      'Native recognition depends on Apple and system settings; the extension cannot enable it for you.',
    ],
  },
  narrator: {
    name: 'Narrator',
    intro: 'Here are the Narrator keys for exploring this image. While a choice is open, use Next, Repeat, or Back. Press Escape to leave this guide.',
    steps: [
      'The Narrator key is Caps Lock by default; it may also be Insert.',
      'Move Narrator focus to the target image and confirm where it is.',
      'Press Narrator plus Control plus D. Narrator may open Copilot with the focused image prepared, and you must choose whether to share it. It does not promise an immediate spoken description.',
      'If Copilot is unavailable, check the Narrator setting “Get image descriptions, page titles, and popular links”. The extension cannot turn that setting on for you.',
      'Microsoft online services may be involved. Native behavior and wording vary by Windows and Narrator version.',
    ],
  },
});

export function detectPlatform(navigatorObject = globalThis.navigator) {
  const platform = navigatorObject?.userAgentData?.platform ?? navigatorObject?.platform ?? '';
  if (/mac/i.test(platform)) return 'voiceover';
  if (/win/i.test(platform)) return 'narrator';
  return null;
}

export function guideFor(platform) {
  return GUIDES[platform] ?? null;
}
