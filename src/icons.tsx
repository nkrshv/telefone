import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3 5 6v5c0 4.4 3 8 7 9 4-1 7-4.6 7-9V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </Base>
  );
}

export function IconMic(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </Base>
  );
}

export function IconMicOff(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9 9V6a3 3 0 0 1 5.12-2.12" />
      <path d="M15 11.34V5" />
      <path d="M5 11a7 7 0 0 0 10.79 5.93" />
      <path d="M19 11a7 7 0 0 1-.11 1.23" />
      <path d="M12 18v3" />
      <path d="m3 3 18 18" />
    </Base>
  );
}

export function IconVideo(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10 5-3v10l-5-3" />
    </Base>
  );
}

export function IconVideoOff(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M16 16H5.5A2.5 2.5 0 0 1 3 13.5v-3A2.5 2.5 0 0 1 5.5 8H6" />
      <path d="M10 8h3.5A2.5 2.5 0 0 1 16 10.5V14" />
      <path d="m16 10 5-3v10" />
      <path d="m3 3 18 18" />
    </Base>
  );
}

export function IconPhoneOff(props: IconProps) {
  // Standard "end call" glyph: a handset tilted down with retracting signal arcs.
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 9c-1.6 0-3.15.25-4.6.7v3.1c0 .39-.23.74-.56.9-.98.49-1.88 1.1-2.66 1.83-.18.16-.42.27-.68.27-.28 0-.53-.11-.71-.29L.29 13.6a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 9.78 7.46 8.5 12 8.5s8.66 1.28 11.71 3.69c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-1.83 2.61c-.18.18-.43.29-.71.29-.26 0-.5-.11-.68-.27a11.6 11.6 0 0 0-2.66-1.83.998.998 0 0 1-.56-.9v-3.1A16.3 16.3 0 0 0 12 9Z" />
    </svg>
  );
}

export function IconWhatsApp(props: IconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.2 8.2 0 0 1 2.42 5.82c0 4.54-3.7 8.24-8.25 8.24a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24ZM8.53 6.85c-.16 0-.43.06-.66.31-.22.25-.86.84-.86 2.05s.88 2.38 1 2.54c.12.16 1.73 2.64 4.2 3.7.59.26 1.04.41 1.4.52.59.19 1.12.16 1.55.1.47-.07 1.45-.59 1.66-1.17.21-.57.21-1.06.14-1.16-.06-.1-.22-.16-.47-.28-.25-.12-1.45-.72-1.68-.8-.22-.08-.39-.12-.55.13-.16.25-.63.79-.77.96-.14.16-.28.18-.53.06-.25-.12-1.04-.38-1.98-1.22-.73-.65-1.23-1.46-1.37-1.71-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.16.04-.31-.02-.43-.06-.12-.54-1.34-.76-1.83-.2-.48-.4-.41-.55-.42-.14-.01-.31-.01-.47-.01Z" />
    </svg>
  );
}

export function IconTelegram(props: IconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M21.94 4.6 18.6 20.3c-.25 1.1-.9 1.38-1.83.86l-5.05-3.72-2.44 2.35c-.27.27-.5.5-1.02.5l.36-5.14L17.98 6.5c.41-.36-.09-.56-.63-.2L5.78 13.6l-4.96-1.55c-1.08-.34-1.1-1.08.23-1.6L20.5 3.05c.9-.34 1.7.2 1.44 1.55Z" />
    </svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Base>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      <circle cx="12" cy="15.3" r="1.2" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconChevron(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m9 6 6 6-6 6" />
    </Base>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Base>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Base>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m5 12 4.5 4.5L19 7" />
    </Base>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Base>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M8 12 6 14a3.5 3.5 0 0 0 5 5l2-2" />
      <path d="M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2" />
    </Base>
  );
}
