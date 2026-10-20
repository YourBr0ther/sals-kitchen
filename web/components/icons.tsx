const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const PhotoIcon = () => (
  <svg {...base}><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-8 8" /></svg>
);
export const LinkIcon = () => (
  <svg {...base}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
);
export const MicIcon = () => (
  <svg {...base}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
export const StopIcon = () => (
  <svg {...base}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>
);
export const SendIcon = () => (
  <svg {...base} strokeWidth={2}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const ChatIcon = () => <svg {...base}><path d="M4 5h16v11H9l-5 4z" /></svg>;
export const TicketIcon = () => (
  <svg {...base}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></svg>
);
export const PeopleIcon = () => (
  <svg {...base}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><circle cx="17" cy="9" r="2.4" /><path d="M16.5 14.6c2.6.2 4.5 2 4.5 4.9" /></svg>
);
export const XIcon = () => <svg {...base}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const PowerIcon = () => (
  <svg {...base}><path d="M8 7a7 7 0 1 0 8 0M12 3v8" /></svg>
);
export const FreshIcon = () => (
  <svg {...base}><path d="M4 12a8 8 0 1 1 2.3 5.7M4 18v-6h6" /></svg>
);
export const SwapIcon = () => (
  <svg {...base}><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" /></svg>
);
export const SpeakerIcon = () => (
  <svg {...base}><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>
);
export const ClockIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
);
export const GearIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></svg>
);
export const BasketIcon = () => (
  <svg {...base}><path d="M4 10h16l-1.6 9H5.6z" /><path d="M8 10l3-6M16 10l-3-6M9 14v2M12 14v2M15 14v2" /></svg>
);
