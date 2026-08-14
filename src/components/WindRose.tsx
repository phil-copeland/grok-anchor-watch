import { cardinalFromRad, radToDeg } from '../units';

interface Props {
  directionRad: number | null;
  speedLabel: string;
  source: string | null;
  isAngleRelative?: boolean;
  /** Absolute wind directions are magnetic by preference */
  isMagnetic?: boolean;
}

/** Simple wind direction indicator (from direction). */
export function WindRose({
  directionRad,
  speedLabel,
  source,
  isAngleRelative,
  isMagnetic = true,
}: Props) {
  const deg = directionRad != null ? radToDeg(directionRad) : 0;
  const has = directionRad != null;
  // Wind arrow points TO where wind goes (downwind); direction is FROM
  const arrowRot = has ? deg + 180 : 0;

  return (
    <div className="wind-rose">
      <div className="wind-compass">
        <div className="wind-ring">
          <span className="wc n">N</span>
          <span className="wc e">E</span>
          <span className="wc s">S</span>
          <span className="wc w">W</span>
          <div
            className={`wind-arrow ${has ? '' : 'dim'}`}
            style={{ transform: `rotate(${arrowRot}deg)` }}
          >
            <svg viewBox="0 0 40 80" width="28" height="56">
              <path
                d="M20 4 L28 36 L22 36 L22 76 L18 76 L18 36 L12 36 Z"
                fill="#7ec8e8"
              />
            </svg>
          </div>
        </div>
      </div>
      <div className="wind-meta">
        <div className="wind-speed">{speedLabel}</div>
        <div className="wind-dir">
          {has
            ? isAngleRelative
              ? `AWA ${Math.round(radToDeg(directionRad!))}°`
              : `${Math.round(deg).toString().padStart(3, '0')}° ${cardinalFromRad(directionRad)}${isMagnetic ? ' M' : ' T'}`
            : '—'}
        </div>
        {source && <div className="wind-src">{source}</div>}
      </div>
    </div>
  );
}
