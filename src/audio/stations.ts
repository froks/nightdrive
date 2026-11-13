export interface Station {
  id: string;
  /** shown on the LED display (≤ 14 chars) */
  name: string;
  /** decorative FM frequency */
  freq: string;
  genre: string;
  url: string;
  /** station homepage, opened by the INFO switch */
  website: string;
  /** Nightride FM channel id for live now-playing metadata */
  nightride?: string;
}

const nr = (id: string, name: string, freq: string, genre: string): Station => ({
  id, name, freq, genre, url: `https://stream.nightride.fm/${id}.mp3`, nightride: id, website: 'https://nightride.fm',
});

/**
 * Stations 1–5 are the preset buttons; ◄◄/►► cycle through all of them.
 * Streams courtesy of Nightride FM (https://nightride.fm) — listener-supported synthwave radio.
 */
export const STATIONS: Station[] = [
  nr('nightride', 'NIGHTRIDE FM', '88.3', 'SYNTHWAVE · RETROWAVE · OUTRUN'),
  nr('chillsynth', 'CHILLSYNTH', '91.7', 'CHILLSYNTH · DREAMWAVE · CHILLWAVE'),
  nr('datawave', 'DATAWAVE', '95.1', 'CHIPTUNE · DATAWAVE · 8-BIT'),
  nr('spacesynth', 'SPACESYNTH', '98.4', 'SPACESYNTH · ITALO · SPACE DISCO'),
  nr('darksynth', 'DARKSYNTH', '102.6', 'DARKSYNTH · CYBERPUNK · SYNTHMETAL'),
  nr('horrorsynth', 'HORRORSYNTH', '106.9', 'HORRORSYNTH · DARKWAVE'),
];
