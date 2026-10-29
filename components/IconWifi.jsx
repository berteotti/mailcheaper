// The status bar's Wi-Fi as iOS draws it: a wedge and two arcs, three layers, not the four-layer icon with a dot.
export default function IconWifi({ className }) {
	return (
		<svg viewBox="0 0 16 12" fill="none" aria-hidden="true" className={className}>
			<path d="M1.7 5.2a8.9 8.9 0 0 1 12.6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			<path d="M4.25 7.7a5.3 5.3 0 0 1 7.5 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			<path d="M8 11.35 6.2 9.25a2.55 2.55 0 0 1 3.6 0Z" fill="currentColor" />
		</svg>
	);
}
