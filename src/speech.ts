/** Browser speech helper for high-water announcements (works on local + remote UI). */

export function speak(text: string) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1;
    utt.pitch = 1;
    utt.volume = 1;
    window.speechSynthesis.speak(utt);
  } catch {
    /* speech unavailable (permissions / unsupported browser) */
  }
}
