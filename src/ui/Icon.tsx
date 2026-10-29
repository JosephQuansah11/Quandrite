/** The icon set, drawn in the current colour so whatever contains it can tint it. */
const PATHS: Record<string, string> = {
  mic: '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18.5V21"/><path d="M8.5 21h7"/>',
  micOff: '<path d="M9 9.5V6a3 3 0 0 1 5.6-1.5"/><path d="M15 11.5V12a3 3 0 0 1-4.4 2.6"/><path d="M19 11a7 7 0 0 1-10.6 6"/><path d="M12 18.5V21"/><path d="M8.5 21h7"/><path d="M3.5 3.5l17 17"/>',
  camera: '<path d="M3 7.5h10.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H3z"/><path d="M15.5 11.2 21 8v8l-5.5-3.2z"/>',
  cameraOff: '<path d="M3 7.5h8"/><path d="M15.5 11.2 21 8v8l-3-1.7"/><path d="M3.5 3.5l17 17"/>',
  screen: '<path d="M3 5h18v11H3z"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  chat: '<path d="M4 5h16v11H8l-4 4z"/>',
  people: '<path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M3.5 19.5c0-2.8 2.4-4.5 5.5-4.5s5.5 1.7 5.5 4.5"/><path d="M16 5.5a3 3 0 0 1 0 6"/><path d="M17.5 15.2c2 .5 3 1.9 3 4.3"/>',
  grid: '<path d="M4 4h7v7H4z"/><path d="M13 4h7v7h-7z"/><path d="M4 13h7v7H4z"/><path d="M13 13h7v7h-7z"/>',
  record: '<path d="M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z"/><path d="M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>',
  leave: '<path d="M14 5h4.5v14H14"/><path d="M11 12H3.5"/><path d="M6.5 8.5 3 12l3.5 3.5"/>',
  play: '<path d="M7 5.5 19 12 7 18.5z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  copy: '<path d="M9 9h10v11H9z"/><path d="M15 6H5v11"/>',
  more: '<path d="M6 12h.01"/><path d="M12 12h.01"/><path d="M18 12h.01"/>',
  bell: '<path d="M12 4a5 5 0 0 0-5 5v4l-1.5 3h13L17 13V9a5 5 0 0 0-5-5z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4.5V10h-5.5"/>',
};

export function Icon({ name, size = 25 }: { name: string; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] || '' }}
    />
  );
}
