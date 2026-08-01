import { useEffect, useRef, useState } from 'react';

/**
 * Anchor radius alarm: visual state + optional Web Audio beeps.
 * When watchEnabled is false, alarms and warnings stay off.
 */
export function useAlarm(
  distanceM: number | null,
  alarmRadiusM: number,
  audioEnabled: boolean,
  watchEnabled = true,
) {
  const [alarming, setAlarming] = useState(false);
  const [muted, setMuted] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const overLimit =
    watchEnabled &&
    distanceM != null &&
    alarmRadiusM > 0 &&
    distanceM > alarmRadiusM;

  // Warning zone: last 5% of radius (95–100%)
  const warning =
    watchEnabled &&
    distanceM != null &&
    alarmRadiusM > 0 &&
    distanceM > alarmRadiusM * 0.95 &&
    distanceM <= alarmRadiusM;

  useEffect(() => {
    setAlarming(overLimit);
  }, [overLimit]);

  // Allow the warning banner to reappear after leaving (and re-entering) the zone
  useEffect(() => {
    if (!warning) setWarningDismissed(false);
  }, [warning]);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!overLimit || !audioEnabled || muted) return;

    const beep = () => {
      try {
        if (!ctxRef.current) {
          ctxRef.current = new AudioContext();
        }
        const ctx = ctxRef.current;
        if (ctx.state === 'suspended') void ctx.resume();

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.value = 0.12;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.onended = () => {
          try {
            osc.disconnect();
            gain.disconnect();
          } catch {
            /* already torn down */
          }
        };
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.stop(ctx.currentTime + 0.4);
      } catch {
        /* audio unavailable */
      }
    };

    beep();
    intervalRef.current = setInterval(beep, 2000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [overLimit, audioEnabled, muted]);

  return {
    alarming,
    warning,
    /** Warning banner visible (false after user dismisses until zone is left) */
    showWarningBanner: warning && !warningDismissed,
    dismissWarning: () => setWarningDismissed(true),
    muted,
    setMuted,
    overLimit,
  };
}
