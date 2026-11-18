// Keys for exploring an image with the user's own screen reader. Every entry
// names the modifier first, then the command, then what the extension cannot
// promise: these features depend on the reader, its version, and the operating
// system, and none of them can be enabled from a web page.
export const GUIDES = Object.freeze({
  voiceover: {
    name: 'VoiceOver',
    intro: 'Here are the VoiceOver keys for exploring this image. They stay in the conversation if you need them again.',
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
    intro: 'Here are the Narrator keys for exploring this image. They stay in the conversation if you need them again.',
    steps: [
      'The Narrator key is Caps Lock by default; it may also be Insert.',
      'Move Narrator focus to the target image and confirm where it is.',
      'Press Narrator plus Control plus D. Narrator may open Copilot with the focused image prepared, and you must choose whether to share it. It does not promise an immediate spoken description.',
      'If Copilot is unavailable, check the Narrator setting “Get image descriptions, page titles, and popular links”. The extension cannot turn that setting on for you.',
      'Microsoft online services may be involved. Native behavior and wording vary by Windows and Narrator version.',
    ],
  },
  nvda: {
    name: 'NVDA',
    intro: 'Here are the NVDA keys for exploring this image. They stay in the conversation if you need them again.',
    steps: [
      'The NVDA key is Insert by default; it may also be set to Caps Lock.',
      'Move the browse-mode cursor to the target image. Press G for the next image or Shift plus G for the previous one.',
      'Press NVDA plus R to recognize the current object with Windows OCR. That reads text found in the image; it does not describe a scene.',
      'NVDA has no built-in scene description. A description add-on from the NVDA add-on store can add one, and it may send the image to an online service.',
      'The extension cannot install or configure an add-on for you. Ask me to describe the image instead if you would rather not set one up.',
    ],
  },
  // No keystrokes here on purpose: Freedom Scientific's documentation could not
  // be checked, and Picture Smart's keys have changed between JAWS versions. A
  // wrong key read aloud is worse than none, so this names the feature and
  // where to find its keys. Add keys only once they are verified against
  // current vendor documentation.
  jaws: {
    name: 'JAWS',
    intro: 'Here is how to explore this image with JAWS. It stays in the conversation if you need it again.',
    steps: [
      'JAWS has its own image description feature, called Picture Smart.',
      'Its keys differ between JAWS versions, and AccessAssist could not confirm the ones for yours, so they are not read out here.',
      'Move to the target image on the page first, then look up Picture Smart in the JAWS help to find the keys for your version.',
      'Picture Smart may send the image to an online service and may need a JAWS account.',
      'The extension cannot enable or configure Picture Smart for you. Ask me to describe the image instead if you would rather not use it.',
    ],
  },
});

export const SCREEN_READER_IDS = Object.freeze(Object.keys(GUIDES));

// All a web page can see is the operating system, which separates VoiceOver
// from Windows readers but cannot tell Narrator, NVDA, and JAWS apart. It is a
// starting guess; resolveReader prefers what the user told us.
export function detectPlatform(navigatorObject = globalThis.navigator) {
  const platform = navigatorObject?.userAgentData?.platform ?? navigatorObject?.platform ?? '';
  if (/mac/i.test(platform)) return 'voiceover';
  if (/win/i.test(platform)) return 'narrator';
  return null;
}

// A stored preference always wins; 'auto' and anything unknown fall back to the
// operating system.
export function resolveReader(stored, navigatorObject = globalThis.navigator) {
  if (typeof stored === 'string' && stored !== 'auto' && stored in GUIDES) return stored;
  return detectPlatform(navigatorObject);
}

// Which readers are plausible on the platform a web page can actually see.
// macOS narrows to VoiceOver outright; Windows cannot be narrowed past these
// three, so the user has to say which one.
const PLATFORM_READERS = Object.freeze({
  voiceover: Object.freeze(['voiceover']),
  narrator: Object.freeze(['narrator', 'nvda', 'jaws']),
});

export function readerChoices(platform) {
  return PLATFORM_READERS[platform] ?? SCREEN_READER_IDS;
}

export function guideFor(platform) {
  return GUIDES[platform] ?? null;
}
