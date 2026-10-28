import { useEffect, useRef } from 'react';

/**
 * A video element showing a stream.
 *
 * Attaching a stream is the one thing every picture in the app has in common - the
 * program feed, a grid tile, the self view - so it is one component. `muted` matters:
 * voices are played by the audio mixer, never by the tiles, or the room would hear
 * everybody twice.
 */
export function Video({
  stream,
  muted = true,
  className = '',
  mirror = false,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  className?: string;
  mirror?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (node.srcObject !== stream) node.srcObject = stream ?? null;
    if (stream) node.play?.().catch(() => undefined);
  }, [stream]);

  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted={muted}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}
