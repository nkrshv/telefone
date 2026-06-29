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
  return (
    <Base {...props}>
      <path d="M10.7 13.3a11 11 0 0 1-2-2C6.3 8.5 5.6 5.8 5.4 4.9a1 1 0 0 1 .7-1.2l2.6-.6a1 1 0 0 1 1.1.6l1 2.3a1 1 0 0 1-.3 1.2l-1.1.8" />
      <path d="M13.3 13.3c.9.6 1.9 1 2.4 1.1a1 1 0 0 0 1.2-.7l.6-2.6a1 1 0 0 0-.6-1.1l-2.1-.9" />
      <path d="m3 3 18 18" />
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
